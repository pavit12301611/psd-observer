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
  render(<CommandPalette onClose={() => {}} onChoose={choose} />);
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
