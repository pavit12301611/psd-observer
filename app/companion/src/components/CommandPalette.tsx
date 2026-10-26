import { useMemo, useState } from "react";
import {
  ArrowUpLeft,
  Play,
  Search,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import catalog from "../data/commands.json";
import { Modal } from "./ui";
/** One catalog entry, with the runnable metadata added for safe commands. */
type Command = (typeof catalog.commands)[number] & {
  runnable?: boolean;
  run?: string;
};
export default function CommandPalette({
  onClose,
  onChoose,
  onRun,
  paired,
}: {
  onClose: () => void;
  onChoose: (text: string) => void;
  onRun?: (text: string) => Promise<string>;
  paired: boolean;
}) {
  const [query, setQuery] = useState("");
  // The last command run from here, so the answer is visible where it was asked.
  const [result, setResult] = useState<{ name: string; text: string } | null>(
    null,
  );
  const [running, setRunning] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const commands = useMemo(
    () =>
      (catalog.commands as Command[])
        .filter((c) =>
          `${c.name} ${c.description} ${c.section}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice(0, 70),
    [query],
  );
  const runCount = catalog.commands.filter((c) => (c as Command).runnable).length;
  async function run(command: Command) {
    if (!onRun || !command.run) return;
    setRunning(command.name);
    setFailure("");
    try {
      const text = await onRun(command.run);
      setResult({ name: command.name, text });
    } catch (e) {
      setFailure(
        e instanceof Error ? e.message : "That command did not answer.",
      );
    } finally {
      setRunning(null);
    }
  }
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
      {result && (
        <div className="command-result" role="status">
          <div className="command-result-head">
            <TerminalSquare size={15} />
            <strong>{result.name}</strong>
            <span>ran on your PC</span>
          </div>
          <pre>{result.text}</pre>
          <div className="button-row">
            <button
              className="text-button"
              onClick={() => {
                onChoose(result.text.slice(0, 4000));
                onClose();
              }}
            >
              Continue in chat
              <ArrowUpLeft size={15} />
            </button>
            <button className="text-button" onClick={() => setResult(null)}>
              Back to commands
            </button>
          </div>
        </div>
      )}
      <div className="command-list">
        {commands.map((command) => (
          <div className="command-item" key={command.name}>
            <button
              className="command-pick"
              type="button"
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
            {/* Read-only commands can run right here; the rest stay drafts. */}
            {command.runnable && onRun && (
              <button
                className="command-run"
                type="button"
                aria-label={`Run ${command.name} on your PC now`}
                disabled={running === command.name || !paired}
                title={
                  paired
                    ? "Run this on your PC now"
                    : "Pair your PC to run commands"
                }
                onClick={() => void run(command)}
              >
                {running === command.name ? "…" : <Play size={14} />}
                <span>{running === command.name ? "Running" : "Run"}</span>
              </button>
            )}
          </div>
        ))}
        {!commands.length && (
          <p className="quiet-empty">
            No matching command. You can still ask in plain language.
          </p>
        )}
      </div>
      {failure && (
        <p className="command-failure" role="status">
          {failure}
        </p>
      )}
      <p className="trust-note">
        <ShieldCheck size={14} />
        Selecting a tool drafts a message; nothing runs until you send. The{" "}
        {runCount} commands marked <strong>Run</strong> are read-only reports on
        your PC and answer here.
      </p>
    </Modal>
  );
}
