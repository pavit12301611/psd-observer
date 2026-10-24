import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  FileText,
  FolderOpen,
  Search,
  Upload,
  RefreshCw,
  LoaderCircle,
  Image,
} from "lucide-react";
import type { Files as FilesData, FileEntry } from "../types";
import { api } from "../core/api";
import { humanBytes } from "../core/storage";
import { EmptyPanel, IconButton, SectionHeading } from "./ui";
export default function Files({
  connected,
  onConnect,
  attach,
  draft,
  notice,
}: {
  connected: boolean;
  onConnect: () => void;
  attach: () => void;
  draft: (s: string) => void;
  notice: (s: string) => void;
}) {
  const [files, setFiles] = useState<FilesData>({ downloads: [], shared: [] }),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState("all"),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError("");
    try {
      setFiles(await api.get<FilesData>("/api/files"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Files unavailable");
    } finally {
      setLoading(false);
    }
  }, [connected]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const source =
    tab === "downloads"
      ? files.downloads
      : tab === "shared"
        ? files.shared
        : [...files.downloads, ...files.shared];
  const filtered = source.filter((f) =>
    (f.name || f.file || f.path).toLowerCase().includes(query.toLowerCase()),
  );
  async function download(file: FileEntry) {
    try {
      await api.download(
        "/api/download?path=" + encodeURIComponent(file.path),
        file.name || file.file || "download",
      );
    } catch (e) {
      notice(e instanceof Error ? e.message : "Download failed");
    }
  }
  return (
    <div className="page-content">
      <SectionHeading
        eyebrow="GOOD IDEAS HAVE ATTACHMENTS"
        title="Bring it together."
        action={
          <button className="button compact" onClick={attach}>
            <Upload size={16} />
            Add a file
          </button>
        }
      >
        Your documents, questions, and things worth keeping.
      </SectionHeading>
      {!connected ? (
        <EmptyPanel
          icon={<FolderOpen size={30} strokeWidth={1.4} />}
          title="A place for the details."
          action={
            <button className="button primary" onClick={onConnect}>
              Connect your PC
              <ArrowRight size={17} />
            </button>
          }
        >
          Find shared files and downloads from your PC agent. Attach a photo or
          document in chat to work through it together.
        </EmptyPanel>
      ) : (
        <>
          <div className="file-toolbar">
            <div className="search-field">
              <Search size={17} />
              <input
                aria-label="Search files"
                placeholder="Find a file…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <IconButton label="Refresh files" onClick={() => void refresh()}>
              <RefreshCw size={18} className={loading ? "spin" : ""} />
            </IconButton>
          </div>
          <div className="segmented file-tabs">
            {[
              ["all", "All files"],
              ["downloads", "Downloads"],
              ["shared", "Shared"],
            ].map(([id, label]) => (
              <button
                className={tab === id ? "selected" : ""}
                onClick={() => setTab(id)}
                key={id}
              >
                {label}
              </button>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="file-list">
            {filtered.map((f, index) => (
              <div className="file-row" key={f.path + index}>
                <span className="file-type">
                  {/\.(png|jpe?g|webp)$/i.test(f.path) ? (
                    <Image size={21} />
                  ) : (
                    <FileText size={21} />
                  )}
                </span>
                <div>
                  <strong>{f.name || f.file || f.path.split("/").pop()}</strong>
                  <small>
                    {f.size ? humanBytes(f.size) : "PC agent file"}
                    {f.ts
                      ? ` · ${new Date(f.ts).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}`
                      : ""}
                  </small>
                </div>
                <IconButton
                  label={`Download ${f.name || f.file || "file"}`}
                  onClick={() => void download(f)}
                >
                  <ArrowDownToLine size={18} />
                </IconButton>
              </div>
            ))}
            {!filtered.length && (
              <div className="quiet-card">
                {loading ? (
                  <LoaderCircle className="spin" size={22} />
                ) : (
                  "No matching files yet. Files received or shared by your agent appear here."
                )}
              </div>
            )}
          </div>
        </>
      )}
      <div className="tool-grid">
        <button className="tool-card" onClick={attach}>
          <Image size={21} />
          <strong>Work through a question</strong>
          <span>Attach a photo, PDF or document</span>
        </button>
        <button className="tool-card" onClick={() => draft("/make report ")}>
          <FileText size={21} />
          <strong>Create something useful</strong>
          <span>Draft a report, slides or a spreadsheet</span>
        </button>
      </div>
      <p className="muted small-text">
        Attachments are capped at 8 MB to keep mobile memory predictable.
        Private file access still follows PC-side allowed roots.
      </p>
    </div>
  );
}
