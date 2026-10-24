import { useMemo, useState } from "react";
import { Search, MessageSquare, Trash2, Plus } from "lucide-react";
import type { Conversation } from "../types";
import { Modal, IconButton } from "./ui";
export default function History({
  conversations,
  onClose,
  onSelect,
  onDelete,
  onNew,
}: {
  conversations: Conversation[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(
    () =>
      conversations
        .filter(
          (c) =>
            c.messages.length &&
            `${c.title} ${c.messages.map((m) => m.text).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) => b.updated - a.updated),
    [query, conversations],
  );
  return (
    <Modal
      title="Pick up a thought."
      subtitle="Your conversations, saved on this device."
      onClose={onClose}
    >
      <div className="search-field">
        <Search size={18} />
        <input
          autoFocus
          aria-label="Search conversations"
          placeholder="Search your conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <button className="button full" onClick={onNew}>
        <Plus size={17} />
        New conversation
      </button>
      <div className="history-list">
        {results.map((c) => (
          <div className="history-row" key={c.id}>
            <button className="history-select" onClick={() => onSelect(c.id)}>
              <MessageSquare size={18} />
              <span>
                <strong>{c.title}</strong>
                <small>
                  {new Date(c.updated).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                  })}{" "}
                  · {c.messages.length} messages
                </small>
              </span>
            </button>
            <IconButton
              label={`Delete ${c.title}`}
              onClick={() => onDelete(c.id)}
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
        ))}
        {!results.length && (
          <p className="quiet-empty">
            A fresh start. Your conversations will appear here.
          </p>
        )}
      </div>
    </Modal>
  );
}
