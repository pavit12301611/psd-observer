import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Markdown from "../src/components/Markdown";
import CommandPalette from "../src/components/CommandPalette";
it("model HTML and javascript links cannot become executable markup", () => {
  const { container } = render(
    <Markdown
      text={
        '<img src=x onerror="alert(1)"><script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n**A clear answer**'
      }
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(screen.getByText("A clear answer").tagName).toBe("STRONG");
});
it("command selection drafts only and filters safely", async () => {
  const choose = vi.fn();
  render(
    <CommandPalette onClose={() => {}} onChoose={choose} paired onRun={vi.fn()} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search commands" }), {
    target: { value: "/shades" },
  });
  await waitFor(() => expect(screen.getByText("/shades")).toBeTruthy());
  fireEvent.click(screen.getByText("/shades"));
  expect(choose).toHaveBeenCalledWith("/shades ");
});

it("PC control is a fixed stage with a dock, not a scrolling stack of cards", async () => {
  const profile = {
    baseUrl: "https://fixture-pc.example",
    token: "fixture",
    deviceId: "d1",
    serverId: "s1",
    protocol: 2,
  } as never;
  const state = {
    apiVersion: 1,
    version: "3.11.0",
    host: "Fixture PC",
    platform: "linux",
    pcControl: true,
    controlPinRequired: true,
    active: [],
    pending: [],
  } as never;
  const { default: PCControl } = await import("../src/components/PCControl");
  const { container } = render(
    <PCControl
      connected
      state={state}
      lowData={false}
      onConnect={() => {}}
      draft={() => {}}
      notice={() => {}}
    />,
  );
  void profile;
  // One stage (the screenshot) and one dock (the controls) live side by side
  // vertically, so neither replaces the other while working.
  expect(container.querySelectorAll(".pc-stage").length).toBe(1);
  expect(container.querySelectorAll(".pc-dock").length).toBe(1);
  expect(container.querySelector(".pc-page")?.className).toContain("page-content");
  for (const name of ["Pad", "Keys", "Type", "Clip", "More"]) {
    expect(screen.getByRole("tab", { name })).toBeTruthy();
  }
  // Zoom is explicit; the old page had no way to read small text.
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset zoom" })).toBeTruthy();
  // Manual input stays opt-in and keeps its PIN field nearby.
  expect(screen.getByLabelText("Enable manual PC input")).toBeTruthy();
  expect(screen.getByLabelText("PC control PIN")).toBeTruthy();
});

it("More lists every destination with its own state, so no tab hunt is needed", async () => {
  const { default: More } = await import("../src/components/More");
  const open = vi.fn(),
    page = vi.fn(),
    hub = vi.fn();
  render(
    <More
      connected
      state={
        {
          apiVersion: 1,
          version: "3.13.0",
          host: "Fixture PC",
          platform: "linux",
          pcControl: true,
          controlPinRequired: true,
          active: [],
          pending: [],
        } as never
      }
      host="192.168.1.12:8787"
      version="1.5.0"
      deviceCount={2}
      alertCount={0}
      dark={false}
      onOpenPage={page}
      onOpenHub={(t) => {
        hub(t);
        open();
      }}
      onToggleTheme={() => {}}
      onConnect={() => {}}
    />,
  );
  // One heading, one list: the seven old hub tabs are plain rows now.
  expect(screen.getByRole("heading", { name: "More" })).toBeTruthy();
  expect(screen.queryByRole("tab")).toBeNull();
  // Rows state their value instead of hiding it behind a tap.
  expect(screen.getAllByText("192.168.1.12:8787").length).toBeGreaterThan(0);
  expect(screen.getByText("2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Files/ }));
  expect(page).toHaveBeenCalledWith("files");
  fireEvent.click(screen.getByRole("button", { name: /^Alerts/ }));
  expect(hub).toHaveBeenCalledWith("alerts");
});

it("every code block carries its own copy button", () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: write } });
  const { container } = render(<Markdown text={"```js\nconst a = 1;\n```"} />);
  const button = screen.getByRole("button", { name: "Copy this code" });
  fireEvent.click(button);
  expect(write).toHaveBeenCalledWith("const a = 1;");
  expect(container.querySelectorAll(".code-block").length).toBe(1);
});

it("a read-only command runs on the PC and answers in the palette", async () => {
  const onRun = vi.fn().mockResolvedValue("Agent status\nUptime: 3h");
  render(
    <CommandPalette
      onClose={() => {}}
      onChoose={vi.fn()}
      onRun={onRun}
      paired
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search commands" }), {
    target: { value: "/todo" },
  });
  await waitFor(() => expect(screen.getByText("/todo")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Run /todo on your PC now" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith("/todo"));
  expect(screen.getByText(/Uptime: 3h/)).toBeTruthy();
  expect(screen.getByText("ran on your PC")).toBeTruthy();
});

it("commands that change something stay drafts, with no Run button", async () => {
  const onRun = vi.fn();
  render(
    <CommandPalette
      onClose={() => {}}
      onChoose={vi.fn()}
      onRun={onRun}
      paired
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search commands" }), {
    target: { value: "/rm" },
  });
  await waitFor(() => expect(screen.getByText("/rm")).toBeTruthy());
  expect(
    screen.queryByRole("button", { name: /^Run \/rm on your PC now$/ }),
  ).toBeNull();
});

it("every catalog entry marked runnable carries the exact text it sends", async () => {
  const catalog = (await import("../src/data/commands.json")).default;
  const runnable = catalog.commands.filter((c) => c.runnable);
  expect(runnable.length).toBeGreaterThan(10);
  for (const c of runnable) {
    expect(c.run, `${c.name} needs the text it runs`).toMatch(/^\/[a-z]/);
    expect(c.run.startsWith(c.name)).toBe(true);
  }
});
