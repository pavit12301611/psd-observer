import { useEffect, useState } from "react";
import { FileText, ArrowDownToLine, LoaderCircle } from "lucide-react";
import { api, base64Blob } from "../core/api";
import type { Media } from "../types";
export default function AuthenticatedMedia({
  media,
  notice,
}: {
  media: Media;
  notice: (s: string) => void;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!["image", "audio"].includes(media.kind || "")) return;
    let alive = true,
      local = "";
    void api
      .wire(media.url, { binary: true })
      .then((r) => {
        if (!alive || !r.base64) return;
        local = URL.createObjectURL(base64Blob(r.base64, media.mime));
        setUrl(local);
      })
      .catch(() => {
        if (alive) setError("Attachment expired or is not reachable.");
      });
    return () => {
      alive = false;
      if (local) URL.revokeObjectURL(local);
    };
  }, [media.id, media.kind, media.url, media.mime]);
  if (media.kind === "image" && /^image\/(png|jpeg|webp)$/.test(media.mime))
    return url ? (
      <img
        className="message-image"
        src={url}
        alt={media.name}
        loading="lazy"
      />
    ) : (
      <p className="small-text muted">
        {error || <LoaderCircle className="spin" size={16} />}
      </p>
    );
  if (media.kind === "audio" && media.mime.startsWith("audio/"))
    return url ? (
      <audio controls src={url} preload="none" />
    ) : (
      <p className="small-text muted">{error || "Loading audio…"}</p>
    );
  return (
    <button
      className="attachment-download"
      onClick={() =>
        void api.download(media.url, media.name).catch((e) => notice(e.message))
      }
    >
      <FileText size={17} />
      <span>{media.name}</span>
      <ArrowDownToLine size={17} />
    </button>
  );
}
