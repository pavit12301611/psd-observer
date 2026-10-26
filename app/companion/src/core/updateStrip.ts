// What the chat page says about a PC-delivered interface update.
//
// The auto-update path used to swallow every refusal, so the only symptom the
// owner ever saw was "no update shows up". A missing bundle, a version that is
// not newer, and a signature that does not match are three different problems
// with three different fixes, so the reason is carried through to the UI.
//
// Pure on purpose: the wording is a contract, not decoration.
import type { PcUpdateCheck } from "../types";

/** The strip for a check result, or null when there is nothing to say. */
export function updateStrip(
  check: PcUpdateCheck | null | undefined,
): { text: string; ready: boolean } | null {
  if (!check) return null;
  if (check.available) {
    const notes = (check.notes || "").trim();
    return {
      text:
        `Interface ${check.version || "update"} is ready from your PC` +
        (notes ? ` — ${notes}` : ""),
      ready: true,
    };
  }
  const reason = (check.reason || "").trim();
  return reason ? { text: reason, ready: false } : null;
}
