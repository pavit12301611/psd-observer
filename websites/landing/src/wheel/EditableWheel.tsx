// src/components/AICreator/EditableWheel.tsx
//
// Wraps OptionWheel with click-to-type: clicking the wheel's center row (the option
// currently in focus) swaps the wheel for a plain autofocused input, styled to match the
// wheel's own row exactly so the swap reads as "the text became editable" rather than a
// mode change. On commit, typed text that doesn't match another preset overwrites the
// CURRENT row's own label in place (via onCustom) — so the wheel comes back showing the
// edited text at that same position, and spinning carries it along like any other row.
// Typing another preset's exact label jumps the wheel to that row instead. Esc reverts to
// the wheel untouched.

import React, { useEffect, useState } from 'react';
import OptionWheel, { type WheelOption } from './OptionWheel';

interface EditableWheelProps<T extends WheelOption> {
  options: T[];
  value: string;
  onChange: (id: string) => void;
  onCustom: (text: string) => void;
  onInteract?: () => void;
  paused?: boolean;
  /** Permanently stops auto-cycling (e.g. once the recipe has been built), same as settling. */
  stopped?: boolean;
  ariaLabel: string;
  widthClass?: string;
  tooltip?: React.ReactNode;
}

function EditableWheel<T extends WheelOption>({
  options, value, onChange, onCustom, onInteract, paused, stopped, ariaLabel, widthClass, tooltip,
}: EditableWheelProps<T>) {
  const displayText = options.find(o => o.id === value)?.label ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayText);
  // Sticks once the row is edited, even across the OptionWheel remount below (entering edit
  // mode unmounts it, so its own internal "interacted" flag can't survive the round trip).
  const [settled, setSettled] = useState(false);

  useEffect(() => { if (!editing) setDraft(displayText); }, [displayText, editing]);
  useEffect(() => { if (stopped) setSettled(true); }, [stopped]);

  const startEdit = () => { setDraft(displayText); setEditing(true); setSettled(true); };

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed.toLowerCase() === displayText.toLowerCase()) { setEditing(false); return; }
    const match = options.find(o => o.id !== value && o.label.toLowerCase() === trimmed.toLowerCase());
    if (match) onChange(match.id);
    else onCustom(trimmed);
    setEditing(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); return; }
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  };

  if (!editing) {
    return (
      <OptionWheel
        options={options}
        value={value}
        onChange={onChange}
        autoCycle={!settled}
        onInteract={() => { setSettled(true); onInteract?.(); }}
        paused={paused}
        ariaLabel={ariaLabel}
        widthClass={widthClass}
        tooltip={tooltip}
        onLabelClick={startEdit}
      />
    );
  }

  return (
    <div className={`flex items-center gap-1.5 md:gap-2 ${widthClass ?? ''}`}>
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={e => e.currentTarget.select()}
        onBlur={commit}
        aria-label={ariaLabel}
        className="w-full bg-transparent border-0 border-b-2 border-white/40 focus:border-white/80 text-center text-lg md:text-xl font-medium text-white outline-none pb-0.5 transition-colors"
      />
    </div>
  );
}

export default EditableWheel;
