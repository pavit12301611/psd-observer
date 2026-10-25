import { describe, expect, it } from "vitest";
import {
  cloudContext,
  compactContext,
  fixFor,
  learnFix,
  looksLikeCommand,
  mentionsPc,
  pickRoute,
} from "../src/core/route";
import type { Message } from "../src/types";

const msg = (role: "user" | "assistant", text: string, route?: Message["route"]) =>
  ({ id: `${role}-${text}`, role, text, ts: 1, route }) as Message;

describe("mentionsPc", () => {
  it("catches the machine itself", () => {
    expect(mentionsPc("my laptop is slow")).toBe(true);
    expect(mentionsPc("pc restart kar do")).toBe(true);
    expect(mentionsPc("whats the battery percentage on this device")).toBe(true);
  });
  it("catches things that only live on the PC", () => {
    expect(mentionsPc("screenshot le ke bhejo")).toBe(true);
    expect(mentionsPc("show me the download folder")).toBe(true);
    expect(mentionsPc("check the wifi status")).toBe(true);
  });
  it("ignores ordinary conversation", () => {
    expect(mentionsPc("write a poem about rain")).toBe(false);
    expect(mentionsPc("what is the capital of france")).toBe(false);
    expect(mentionsPc("kal mausam kaisa rahega")).toBe(false);
  });

  it("matches whole words only, so a noun never hides inside another word", () => {
    expect(mentionsPc("explain diagrams for my exam")).toBe(false);
    expect(mentionsPc("book a booth for the party")).toBe(false);
    expect(mentionsPc("wifi password batao")).toBe(true);
  });
});

describe("looksLikeCommand", () => {
  it("catches slash commands", () => {
    expect(looksLikeCommand("/status")).toBe(true);
    expect(looksLikeCommand("  /stop")).toBe(true);
  });
  it("catches imperative action verbs in both languages", () => {
    expect(looksLikeCommand("open notepad")).toBe(true);
    expect(looksLikeCommand("screenshot bhejo")).toBe(true);
    expect(looksLikeCommand("file khol ke dikhao")).toBe(true);
    expect(looksLikeCommand("volume badhao")).toBe(true);
  });
  it("leaves questions and statements alone", () => {
    expect(looksLikeCommand("can you explain closures")).toBe(false);
    expect(looksLikeCommand("the shop is open")).toBe(false);
    expect(looksLikeCommand("kya haal hai")).toBe(false);
  });
});

describe("pickRoute", () => {
  const auto = { mode: "auto" as const, cloudReady: true, paired: true };

  it("defaults every ordinary message to Direct AI", () => {
    expect(pickRoute("explain black holes simply", auto)).toBe("cloud");
    expect(pickRoute("ek email draft kar", auto)).toBe("cloud");
  });

  it("sends PC talk and commands to the PC inside the same chat", () => {
    expect(pickRoute("mere laptop pe kaam kar", auto)).toBe("agent");
    expect(pickRoute("open the terminal and run ls", auto)).toBe("agent");
    expect(pickRoute("/status", auto)).toBe("agent");
  });

  it("sends attachments to the PC because Direct AI is text-only", () => {
    expect(pickRoute("is this invoice correct", { ...auto, hasFile: true })).toBe(
      "agent",
    );
  });

  it("honours a manual pin in both directions", () => {
    expect(
      pickRoute("mere laptop pe kaam kar", { ...auto, mode: "cloud" }),
    ).toBe("cloud");
    expect(pickRoute("kaun si movie dekhein", { ...auto, mode: "agent" })).toBe(
      "agent",
    );
  });

  it("never routes to Direct AI before a key is saved", () => {
    expect(pickRoute("explain black holes", { ...auto, cloudReady: false })).toBe(
      "agent",
    );
    expect(pickRoute("open the terminal", { ...auto, cloudReady: false })).toBe(
      "agent",
    );
  });

  it("still answers on Direct AI when no PC is paired", () => {
    // The point of the default: the phone works with no laptop in the room.
    expect(
      pickRoute("explain black holes", { ...auto, paired: false }),
    ).toBe("cloud");
    expect(pickRoute("mere pc pe file dhoondo", { ...auto, paired: false })).toBe(
      "agent",
    );
  });

  it("asks for a key when there is no engine at all", () => {
    // Nothing paired, no key: the app must open the key sheet, not the PC dialog.
    expect(
      pickRoute("explain black holes", {
        ...auto,
        cloudReady: false,
        paired: false,
      }),
    ).toBe("cloud");
  });

  it("is stable for empty and whitespace input", () => {
    expect(pickRoute("", auto)).toBe("cloud");
    expect(pickRoute("   ", auto)).toBe("cloud");
  });
});

describe("cloudContext", () => {
  it("replaces PC answers with a placeholder so nothing leaves the PC", () => {
    const out = cloudContext([
      msg("user", "what is the wifi password on my pc"),
      msg("assistant", "SSID Observer, key hunter2", "agent"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("what is the wifi password on my pc");
    expect(out[1].text).not.toContain("hunter2");
    expect(out[1].text).toMatch(/handled on your pc/i);
  });

  it("keeps Direct AI turns verbatim", () => {
    const out = cloudContext([msg("assistant", "A haiku about rain.", "cloud")]);
    expect(out[0].text).toBe("A haiku about rain.");
  });

  it("does not mutate the messages on screen", () => {
    const original = [msg("assistant", "ran the backup", "agent")];
    cloudContext(original);
    expect(original[0].text).toBe("ran the backup");
  });
});

describe("owner corrections", () => {
  it("a correction beats the classifier in auto mode", () => {
    // "notepad kholo" reads as a command, so the classifier says PC. The owner
    // who wanted a Direct AI answer instead is remembered.
    expect(pickRoute("notepad kholo", { mode: "auto" })).toBe("agent");
    const fixes = learnFix([], "notepad kholo", "cloud");
    expect(pickRoute("notepad kholo", { mode: "auto", fixes })).toBe("cloud");
  });

  it("matches case and spacing only, never a different sentence", () => {
    const fixes = learnFix([], "  What   time is it  ", "cloud");
    expect(fixFor(fixes, "what time is it")).toBe("cloud");
    expect(fixFor(fixes, "what time is it in tokyo")).toBeNull();
  });

  it("keeps the newest choice for a sentence", () => {
    let fixes = learnFix([], "kaam khatam?", "cloud");
    fixes = learnFix(fixes, "kaam khatam?", "agent");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].route).toBe("agent");
  });

  it("stays bounded, so the phone never grows forever", () => {
    let fixes: ReturnType<typeof learnFix> = [];
    for (let i = 0; i < 90; i++) fixes = learnFix(fixes, `sentence ${i}`, "cloud");
    expect(fixes).toHaveLength(60);
    expect(fixes[0].text).toBe("sentence 30");
    expect(fixFor(fixes, "sentence 0")).toBeNull();
  });

  it("a manual pin still beats a correction", () => {
    const fixes = learnFix([], "pc band karo", "cloud");
    expect(pickRoute("pc band karo", { mode: "agent", fixes })).toBe("agent");
  });

  it("ignores empty and near-empty noise", () => {
    expect(learnFix([], "  ", "cloud")).toEqual([]);
    expect(learnFix([], "hi", "cloud")).toEqual([]);
    expect(learnFix([], "ok", "agent")).toEqual([]);
    expect(learnFix([], "notepad kholo", "cloud")).toHaveLength(1);
  });
});

describe("compactContext", () => {
  const chat = Array.from({ length: 14 }, (_, i) =>
    msg("user", `message number ${i}`, "agent"),
  );
  it("short threads are left alone", () => {
    const short = [msg("user", "hello"), msg("assistant", "hi", "cloud")];
    expect(compactContext(short)).toEqual(short);
  });

  it("folds older turns into one summary and keeps the recent ones", () => {
    const out = compactContext(chat);
    expect(out).toHaveLength(7);
    expect(out[0].id).toBe("context-summary");
    expect(out[0].text).toContain("8 messages");
    expect(out.slice(1).map((m) => m.text)).toEqual([
      "message number 8",
      "message number 9",
      "message number 10",
      "message number 11",
      "message number 12",
      "message number 13",
    ]);
  });

  it("counts PC answers but never quotes them", () => {
    const mixed = [
      ...chat,
      msg("assistant", "PC said: the wifi key is hunter2", "agent"),
      msg("user", "aur ek baat"),
      msg("user", "and the last thing"),
    ];
    const out = compactContext(mixed, { keep: 2 });
    expect(out[0].text).toContain("handled on the PC");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
});
