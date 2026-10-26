import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * These guard the bugs that only appear on a phone, where the layout viewport
 * and the visible viewport are not the same thing. jsdom reports every element
 * as 0x0, so the only honest assertion is on the CSS custom property and the
 * inline height the app computes from it.
 */
const styleOf = (el: Element | null) =>
  (el as HTMLElement | null)?.style ?? { getPropertyValue: () => "" };

let listeners: Record<string, Set<EventListener>>;

beforeEach(() => {
  listeners = {};
  const track = (target: EventTarget) => {
    const proto = target as unknown as {
      addEventListener: (t: string, l: EventListener) => void;
      removeEventListener: (t: string, l: EventListener) => void;
    };
    const add = proto.addEventListener.bind(target);
    const remove = proto.removeEventListener.bind(target);
    proto.addEventListener = (t: string, l: EventListener) => {
      (listeners[t] ??= new Set()).add(l);
      add(t, l);
    };
    proto.removeEventListener = (t: string, l: EventListener) => {
      listeners[t]?.delete(l);
      remove(t, l);
    };
  };
  track(window);
  if (window.visualViewport) track(window.visualViewport);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fire = (type: string) => {
  for (const l of [...(listeners[type] ?? [])]) l(new Event(type));
};

it("--app-height follows the visible viewport, with or without visualViewport", async () => {
  const { default: App } = await import("../src/App");
  Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });

  // Case 1: visualViewport exists and shrinks when the URL bar collapses.
  const vv = {
    height: 640,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  let view = render(<App />);
  expect(styleOf(document.documentElement).getPropertyValue("--app-height")).toBe(
    "640px",
  );
  vv.height = 580;
  act(() => fire("resize"));
  expect(styleOf(document.documentElement).getPropertyValue("--app-height")).toBe(
    "580px",
  );
  view.unmount();

  // Case 2: WebViews without visualViewport still track rotation. This is the
  // regression: the old code only ever attached a visualViewport listener, so
  // the shell kept the pre-rotation height and pushed the composer off-screen.
  Object.defineProperty(window, "visualViewport", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });
  view = render(<App />);
  expect(styleOf(document.documentElement).getPropertyValue("--app-height")).toBe(
    "640px",
  );
  Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
  act(() => fire("resize"));
  expect(styleOf(document.documentElement).getPropertyValue("--app-height")).toBe(
    "400px",
  );
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  act(() => fire("orientationchange"));
  expect(styleOf(document.documentElement).getPropertyValue("--app-height")).toBe(
    "900px",
  );
  view.unmount();
});

it("no viewport-relative max-height survives in the stylesheet", async () => {
  const css = await import("fs").then((fs) =>
    fs.readFileSync("src/styles.css", "utf8"),
  );
  // vh sizes against the layout viewport, which does not shrink when the mobile
  // URL bar or the keyboard appears, so panels built on it clip their content.
  const offenders = css.match(/max-height:\s*[\d.]+vh/g) ?? [];
  expect(offenders, `raw vh max-heights: ${offenders.join(", ")}`).toEqual([]);
  // The modal is sized off the same tracked variable so it stays on screen
  // while the on-screen keyboard is open.
  expect(css).toContain("max-height: calc(var(--app-height) - 48px)");
});


it("the composer re-measures when the box width changes, not only on keystrokes", async () => {
  const { default: App } = await import("../src/App");
  const { container } = render(<App />);
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(box).toBeTruthy();
  let scrollHeight = 80;
  Object.defineProperty(box, "scrollHeight", {
    get: () => scrollHeight,
    configurable: true,
  });
  // A rotation, a split-screen resize and the on-screen keyboard all change how
  // many lines the draft wraps to. The stored inline height has to follow, or
  // the textarea keeps a stale height and clips its own text.
  scrollHeight = 190;
  act(() => fire("resize"));
  expect(box.style.height).toBe("160px");
  scrollHeight = 44;
  act(() => fire("resize"));
  expect(box.style.height).toBe("44px");
  scrollHeight = 120;
  act(() => fire("orientationchange"));
  expect(box.style.height).toBe("120px");
});
