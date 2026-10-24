import { isNative, nativeCall } from "./native";
type SpeechResult = {
  results: { [n: number]: { [n: number]: { transcript: string } } };
};
type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResult) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};
let recognizer: Recognizer | null = null;
export function cancelSpeech() {
  recognizer?.abort();
  recognizer = null;
  window.speechSynthesis?.cancel();
  if (isNative()) void nativeCall("stopSpeech").catch(() => {});
}
export function dictate(language: string): Promise<string> {
  if (isNative())
    return nativeCall<{ text: string }>("recognize", { language }, 75_000).then(
      (r) => r.text,
    );
  const Constructor =
    (
      window as unknown as {
        SpeechRecognition?: new () => Recognizer;
        webkitSpeechRecognition?: new () => Recognizer;
      }
    ).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: new () => Recognizer })
      .webkitSpeechRecognition;
  if (!Constructor)
    return Promise.reject(
      new Error(
        "Speech recognition is unavailable in this browser. Use the Android app or type your message.",
      ),
    );
  return new Promise((resolve, reject) => {
    recognizer?.abort();
    const r = new Constructor();
    recognizer = r;
    let finished = false;
    const done = (text?: string, error?: string) => {
      if (finished) return;
      finished = true;
      recognizer = null;
      if (error) reject(new Error(error));
      else resolve(text || "");
    };
    r.lang = language;
    r.continuous = false;
    r.interimResults = true;
    r.onresult = (e) => {
      const result = e.results[0] as (typeof e.results)[0] & {
        isFinal?: boolean;
      };
      const text = result?.[0]?.transcript || "";
      window.dispatchEvent(
        new CustomEvent("observer-speech-partial", { detail: text }),
      );
      if (result?.isFinal !== false) done(text);
    };
    r.onerror = (e) =>
      done(
        undefined,
        `Speech: ${e.error}. Your phone may need a speech provider and network.`,
      );
    r.onend = () => done("");
    r.start();
  });
}
export function speak(text: string, language: string) {
  const clean = text.replace(/[`*#_]/g, "").slice(0, 2200);
  if (isNative())
    void nativeCall("speak", { text: clean, language }).catch(() => {});
  else if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = language;
    window.speechSynthesis.speak(u);
  }
}

export function speakAndWait(text: string, language: string): Promise<void> {
  const clean = text.replace(/[`*#_]/g, "").slice(0, 2200);
  if (isNative())
    return nativeCall(
      "speak",
      { text: clean, language, wait: true },
      240000,
    ).then(() => {});
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = language;
    u.onend = () => resolve();
    u.onerror = () => reject(new Error("Playback interrupted"));
    window.speechSynthesis.speak(u);
  });
}
