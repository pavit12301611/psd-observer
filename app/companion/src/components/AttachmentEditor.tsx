import { useRef, useState } from "react";
import { Check, RotateCcw, Pencil } from "lucide-react";
import type { Attachment } from "../types";
import { Modal } from "./ui";
type Line = { color: string; points: { x: number; y: number }[] };
export default function AttachmentEditor({
  file,
  onClose,
  onSave,
}: {
  file: Attachment;
  onClose: () => void;
  onSave: (a: Attachment) => void;
}) {
  const image = useRef<HTMLImageElement>(null),
    stage = useRef<HTMLDivElement>(null),
    drawing = useRef(false);
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 100, h: 100 }),
    [lines, setLines] = useState<Line[]>([]),
    [color, setColor] = useState("#000000"),
    [pen, setPen] = useState(false),
    [error, setError] = useState("");
  function point(e: React.PointerEvent) {
    const r = stage.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function apply() {
    try {
      const img = image.current;
      if (!img?.naturalWidth) throw Error("Image is not ready.");
      const source = document.createElement("canvas");
      source.width = img.naturalWidth;
      source.height = img.naturalHeight;
      if (source.width * source.height > 32_000_000)
        throw Error(
          "Use a lower-resolution source (up to 32 MP) to protect phone memory.",
        );
      const ctx = source.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      for (const line of lines) {
        ctx.beginPath();
        ctx.strokeStyle = line.color;
        ctx.lineWidth = Math.max(source.width, source.height) / 220;
        ctx.lineCap = "round";
        line.points.forEach((p, i) =>
          i
            ? ctx.lineTo(p.x * source.width, p.y * source.height)
            : ctx.moveTo(p.x * source.width, p.y * source.height),
        );
        ctx.stroke();
      }
      const x = Math.round((crop.x / 100) * source.width),
        y = Math.round((crop.y / 100) * source.height),
        w = Math.max(1, Math.round((crop.w / 100) * source.width)),
        h = Math.max(1, Math.round((crop.h / 100) * source.height));
      const out = document.createElement("canvas"),
        scale = Math.min(1, 2048 / Math.max(w, h));
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(h * scale));
      out
        .getContext("2d")!
        .drawImage(source, x, y, w, h, 0, 0, out.width, out.height);
      const data = out.toDataURL("image/jpeg", 0.9),
        base64 = data.split(",")[1],
        size = Math.floor((base64.length * 3) / 4);
      if (size > 8 * 1024 * 1024)
        throw Error("Edited image still exceeds the 8 MB budget.");
      onSave({
        name: file.name.replace(/\.[^.]+$/, "") + "-edited.jpg",
        mime: "image/jpeg",
        base64,
        preview: data,
        size,
      });
      source.width = source.height = 1;
      out.width = out.height = 1;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare that crop.");
    }
  }
  return (
    <Modal
      title="Keep the useful part."
      subtitle="Crop or mark a photo before uploading. Apply only updates the draft; nothing is sent yet."
      onClose={onClose}
      wide
    >
      <div
        className="edit-stage"
        ref={stage}
        onPointerDown={(e) => {
          if (!pen) return;
          drawing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setLines((a) => [...a, { color, points: [point(e)] }]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = point(e);
          setLines((a) =>
            a.map((l, i) =>
              i === a.length - 1
                ? { ...l, points: [...l.points.slice(-300), p] }
                : l,
            ),
          );
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      >
        <img
          ref={image}
          src={file.preview || `data:${file.mime};base64,${file.base64}`}
          alt="Photo being cropped and annotated"
        />
        <svg
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {lines.map((l, i) => (
            <polyline
              key={i}
              points={l.points
                .map((p) => `${p.x * 1000},${p.y * 1000}`)
                .join(" ")}
              fill="none"
              stroke={l.color}
              strokeWidth="5"
            />
          ))}
          <rect
            x={crop.x * 10}
            y={crop.y * 10}
            width={crop.w * 10}
            height={crop.h * 10}
            fill="none"
            stroke="#000"
            strokeWidth="5"
            strokeDasharray="9 9"
          />
          <rect
            x={crop.x * 10}
            y={crop.y * 10}
            width={crop.w * 10}
            height={crop.h * 10}
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeDasharray="9 9"
          />
        </svg>
      </div>
      <div className="button-row">
        <button
          className={`button ${pen ? "primary" : ""}`}
          onClick={() => setPen(!pen)}
        >
          <Pencil size={15} />
          {pen ? "Pen on" : "Mark up"}
        </button>
        <button
          className="button"
          onClick={() => setColor(color === "#000000" ? "#ffffff" : "#000000")}
        >
          Pen: {color === "#000000" ? "black" : "white"}
        </button>
        <button
          className="button"
          onClick={() => {
            setCrop({ x: 0, y: 0, w: 100, h: 100 });
            setLines([]);
          }}
        >
          <RotateCcw size={15} />
          Reset
        </button>
      </div>
      <div className="crop-fields">
        {(["x", "y", "w", "h"] as const).map((key) => (
          <label key={key}>
            {{ x: "Left", y: "Top", w: "Width", h: "Height" }[key]} %
            <input
              aria-label={`Crop ${key}`}
              type="number"
              min={key === "w" || key === "h" ? 1 : 0}
              max={100}
              value={crop[key]}
              onChange={(e) => {
                const value = Math.max(
                  key === "w" || key === "h" ? 1 : 0,
                  Math.min(
                    key === "x" || key === "y" ? 99 : 100,
                    Number(e.target.value) || 0,
                  ),
                );
                setCrop((c) => {
                  const n = { ...c, [key]: value };
                  n.w = Math.min(n.w, 100 - n.x || 1);
                  n.h = Math.min(n.h, 100 - n.y || 1);
                  return n;
                });
              }}
            />
          </label>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="button-row">
        <button className="button" onClick={onClose}>
          Keep original
        </button>
        <button className="button primary" onClick={apply}>
          <Check size={16} />
          Apply to draft
        </button>
      </div>
    </Modal>
  );
}
