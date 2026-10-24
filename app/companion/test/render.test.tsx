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
