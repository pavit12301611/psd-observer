import { useMemo, useState } from "react";
import { ArrowUpLeft, Search, TerminalSquare, ShieldCheck } from "lucide-react";
import catalog from "../data/commands.json";
import { Modal } from "./ui";
export default function CommandPalette({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const commands = useMemo(
    () =>
      catalog.commands
        .filter((c) =>
          `${c.name} ${c.description} ${c.section}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice(0, 70),
    [query],
  );
  return (
    <Modal
      title="A little more capable."
      subtitle={`${catalog.commands.length} commands from your existing agent. Search to find a tool.`}
      onClose={onClose}
      wide
    >
      <div className="search-field">
        <Search size={18} />
        <input
          aria-label="Search commands"
          autoFocus
          placeholder="Try files, study, screenshot, memory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="command-list">
        {commands.map((command) => (
          <button
            className="command-item"
            type="button"
            key={command.name}
            onClick={() => onChoose(command.name + " ")}
          >
            <span className="command-icon">
              <TerminalSquare size={17} />
            </span>
            <span>
              <strong>{command.name}</strong>
              <small>
                {command.description
                  .replace(/\/[a-z0-9_-]+/gi, "")
                  .replace(/^[\s·]+/, "")
                  .slice(0, 145) || command.section}
              </small>
            </span>
            <ArrowUpLeft size={17} />
          </button>
        ))}
        {!commands.length && (
          <p className="quiet-empty">
            No matching command. You can still ask in plain language.
          </p>
        )}
      </div>
      <p className="trust-note">
        <ShieldCheck size={14} />
        Selecting a tool only drafts a message. Nothing runs until you send.
      </p>
    </Modal>
  );
}
