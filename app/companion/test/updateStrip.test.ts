// The chat-page update strip. Its whole job is to say something true when the
// PC has nothing to offer, so an empty strip is a bug, not a design choice.
import { describe, expect, test } from "vitest";
import { updateStrip } from "../src/core/updateStrip";
import type { PcUpdateCheck } from "../src/types";

const check = (over: Partial<PcUpdateCheck> = {}): PcUpdateCheck => ({
  installed: "",
  available: false,
  ...over,
});

describe("updateStrip", () => {
  test("nothing to say means no strip at all", () => {
    expect(updateStrip(null)).toBeNull();
    expect(updateStrip(undefined)).toBeNull();
    // A refusal with no reason must not render an empty card.
    expect(updateStrip(check())).toBeNull();
    expect(updateStrip(check({ reason: "   " }))).toBeNull();
  });

  test("an offered bundle is an offer, with its notes", () => {
    const ready = updateStrip(
      check({ available: true, version: "1.5.2", notes: "quick actions" }),
    );
    expect(ready).toEqual({
      text: "Interface 1.5.2 is ready from your PC — quick actions",
      ready: true,
    });
  });

  test("an offered bundle without notes stays a single clean line", () => {
    const ready = updateStrip(check({ available: true, version: "1.5.2" }));
    expect(ready?.ready).toBe(true);
    expect(ready?.text).toBe("Interface 1.5.2 is ready from your PC");
    expect(ready?.text).not.toContain("undefined");
  });

  test("a refusal carries the exact reason the owner can act on", () => {
    for (const reason of [
      "No signed interface update has been prepared on your PC yet.",
      "The signed update on your PC is not newer than the installed interface.",
      "This update needs a newer Observer app (1.6.0). Install the APK once, then retry.",
      "The PC offered an update signed by a different key. Nothing was installed.",
    ]) {
      expect(updateStrip(check({ reason }))).toEqual({ text: reason, ready: false });
    }
  });

  test("a version-less offer still names the update", () => {
    const ready = updateStrip(check({ available: true }));
    expect(ready?.text).toBe("Interface update is ready from your PC");
  });
});
