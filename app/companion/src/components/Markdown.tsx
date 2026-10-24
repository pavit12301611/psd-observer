import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '../core/native';
export default function Markdown({ text }: { text: string }) {
  // No rehype-raw, HTML insertion, iframes or model-supplied scripts.
  const source = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?:)])/g, '$1**$2**');
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); if (href && /^https?:\/\//i.test(href)) openExternal(href); }}>{children}</a>,
    table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
  }}>{source}</ReactMarkdown></div>;
}
