export function pairingQR(raw: string): {
  origin: string;
  code: string;
  serverId: string;
  expiresAt: number;
} {
  if (raw.length > 5000) throw new Error("Pairing QR is too large");
  const u = new URL(raw);
  if (
    u.protocol !== "observer-companion:" ||
    u.hostname !== "pair" ||
    u.searchParams.getAll("payload").length !== 1
  )
    throw new Error("This is not an Observer pairing QR");
  const encoded = u.searchParams.get("payload") || "",
    data = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
  if (
    typeof data.origin !== "string" ||
    !/^[a-zA-Z0-9_-]{32}$/.test(data.code) ||
    !/^[a-f0-9]{32}$/.test(data.serverId) ||
    data.protocol !== 2
  )
    throw new Error("Invalid pairing QR");
  return {
    origin: data.origin,
    code: data.code,
    serverId: data.serverId,
    expiresAt: data.expiresAt,
  };
}
export function connectionHelp(message: string): {
  title: string;
  tips: string[];
} {
  const text = message.toLowerCase();
  if (/certificate|ssl|trust anchor/.test(text))
    return {
      title: "HTTPS certificate was not trusted",
      tips: [
        "Use a valid HTTPS certificate. Never bypass certificate verification.",
        "For a private LAN/VPN IP only, explicitly opt into HTTP if you understand the transport risk.",
      ],
    };
  if (/wrong pin|expired.*qr|401/.test(text))
    return {
      title: "Pairing was rejected",
      tips: [
        "Use the dashboard PIN, not the phone unlock PIN or WhatsApp OTP.",
        "Generate a fresh one-use QR; do not keep guessing a PIN.",
      ],
    };
  if (/3\.10|old|protocol|404/.test(text))
    return {
      title: "PC agent needs an update",
      tips: [
        "This release needs PC agent 3.10.0+.",
        "Use the main branch updater. Merging GitHub code alone does not update the installed PC service.",
      ],
    };
  return {
    title: "The phone could not reach the PC",
    tips: [
      "Verify the actual PC IP; do not use phone localhost.",
      "Keep both devices on a trusted LAN or encrypted private VPN; avoid guest Wi-Fi isolation.",
      "On the PC check the service, 0.0.0.0:8787 listener, then local /health.",
      "If phone Chrome /health works but the app does not, check per-app VPN/network restrictions.",
      "Do not disable the firewall or publicly forward the raw agent port.",
    ],
  };
}

export function supportsMobileV2(version: string): boolean {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  return Boolean(
    m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10)),
  );
}
