import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { openExternal } from "../core/native";

/**
 * Code blocks get their own copy button. On a phone, selecting a block by hand
 * is miserable, so every block offers one tap that copies exactly its text —
 * read from the rendered node, never re-serialised, so nothing drifts.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState(false);
  return (
    <div className="code-block">
      <button
        type="button"
        className="code-copy"
        aria-label={done ? "Copied" : "Copy this code"}
        onClick={() => {
          const text = ref.current?.textContent ?? "";
          navigator.clipboard
            ?.writeText(text.replace(/\n$/, ""))
            .then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1600);
            })
            .catch(() => setDone(false));
        }}
      >
        {done ? <Check size={14} /> : <Copy size={14} />}
        <span>{done ? "Copied" : "Copy"}</span>
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  // No rehype-raw, HTML insertion, iframes or model-supplied scripts.
  const source = text.replace(
    /(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?:)])/g,
    "$1**$2**",
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) openExternal(href);
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
