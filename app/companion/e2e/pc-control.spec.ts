import { test, expect, type Page } from "@playwright/test";

/**
 * PC control is used one-handed, from a phone, while looking at a PC that is
 * far away. The regression this file guards is concrete: the page used to
 * scroll, so reaching the touchpad pushed the screenshot off-screen and every
 * gesture moved the UI instead of the PC cursor.
 */

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+juxkAAAAASUVORK5CYII=";

function fixture(page: Page) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const state = {
    apiVersion: 1,
    version: "3.11.0",
    host: "Fixture PC",
    platform: "linux",
    pcControl: true,
    controlPinRequired: true,
    active: [] as { id: number; label: string; detail: string; startedAt: number; elapsedMs: number }[],
    pending: [],
  };
  const pcState = {
    session: "wayland",
    graphical: true,
    locked: false,
    display: "on",
    battery: { percent: 64, charging: false },
    diskFreeMb: 40960,
    host: "Fixture PC",
    pcControl: true,
    controlPinRequired: true,
    accessLevel: "full",
    busy: false,
    activeJobs: 0,
  };
  const install = () =>
    page.route("**/bridge/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace("/bridge", "");
      const body = route.request().postDataJSON() || {};
      requests.push({ path: path + url.search, body });
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (path === "/health")
        return json({ ok: true, service: "observer-whatsapp-agent", version: "3.11.0" });
      if (path === "/api/app/pair")
        return json({
          token: "fixture-token",
          protocol: 2,
          capabilities: { jobs: true, durableJobs: true },
          device: { id: "fixture-device" },
          serverId: "fixture-server",
        });
      if (route.request().headers()["x-bridge-token"] !== "fixture-token")
        return json({ detail: "Unauthorized" }, 401);
      if (path === "/api/app/state") return json(state);
      if (path === "/api/status")
        return json({ version: "3.11.0", model: "fixture", whatsapp: "not connected", stats: {} });
      if (path.startsWith("/api/app/events")) return json({ epoch: "e", latest: 0, events: [] });
      if (path === "/api/app/projects") return json({ projects: [] });
      if (path === "/api/app/workflows") return json({ workflows: [] });
      if (path === "/api/app/jobs") return json({ jobs: [] });
      if (path === "/api/pc/state") return json(pcState);
      if (path === "/api/clipboard")
        return route.request().method() === "POST"
          ? json({ ok: true, chars: String(body.text || "").length })
          : json({ text: "copied on the PC", truncated: false });
      if (path === "/api/pc/display") return json({ ok: true, woken: ["gdbus"] });
      if (path.startsWith("/api/screen"))
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          // The app needs the real screen size to place its pointer marker.
          headers: { "x-screen-width": "1920", "x-screen-height": "1080" },
          body: Buffer.from(PNG, "base64"),
        });
      if (path === "/api/chat") {
        if (body.text === "/stop") {
          // A real /stop settles the job, which is what frees manual input.
          pcState.busy = false;
          state.active = [];
        }
        return json({ ok: true, text: body.text === "/stop" ? "Stop requested." : "ok" });
      }
      if (path === "/api/notice") return json({ notice: null });
      return json({ ok: true });
    });
  return { install, requests, state, pcState };
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect PC", exact: true }).click();
  await page.getByLabel("PC bridge address").fill("https://fixture-pc.example");
  await page.getByLabel("Dashboard PIN").fill("123456");
  await page.getByRole("button", { name: "Connect my PC", exact: true }).click();
  await expect(page.getByRole("button", { name: "PC connected", exact: true })).toBeVisible();
}
const go = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: /Workspace|Mobile navigation/ })
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .click();

test("PC control fits one phone screen: the stage never scrolls away from the dock", async ({ page }) => {
  const f = fixture(page);
  await f.install();
  await page.goto("/");
  await connect(page);
  await go(page, "PC control");
  // Wait for the control surface itself; a fresh mount is not instant.
  await expect(page.locator(".pc-shell")).toBeVisible();
  await expect(page.locator(".pc-stage img")).toBeVisible();
  await expect(page.locator(".pc-stage")).toBeVisible();
  await expect(page.locator(".pc-dock")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const shell = document.querySelector(".pc-shell") as HTMLElement | null;
    const stage = document.querySelector(".pc-stage") as HTMLElement | null;
    const dock = document.querySelector(".pc-dock") as HTMLElement | null;
    const page_ = document.querySelector(".pc-page") as HTMLElement | null;
    return {
      shell: shell?.getBoundingClientRect(),
      stage: stage?.getBoundingClientRect(),
      dock: dock?.getBoundingClientRect(),
      pageScroll: page_ ? page_.scrollHeight - page_.clientHeight : -1,
      innerHeight: window.innerHeight,
    };
  });
  expect(metrics.shell).toBeTruthy();
  expect(metrics.stage).toBeTruthy();
  expect(metrics.dock).toBeTruthy();
  // The page itself must not be a scroller.
  expect(metrics.pageScroll).toBeLessThanOrEqual(1);
  // Both the screenshot and the controls must be on screen at the same time.
  expect(metrics.stage!.top).toBeGreaterThanOrEqual(0);
  expect(metrics.stage!.height).toBeGreaterThan(40);
  expect(metrics.dock!.top).toBeGreaterThan(metrics.stage!.top + 40);
  expect(metrics.dock!.bottom).toBeLessThanOrEqual(metrics.innerHeight);
  // The dock must be a real surface, not a strip clipped by the screen above.
  const dockBody = await page
    .locator(".pc-dock-body")
    .evaluate((el) => el.clientHeight);
  expect(dockBody).toBeGreaterThan(48);
});

test("touchpad drags move the PC cursor without scrolling the page", async ({ page }) => {
  const f = fixture(page);
  await f.install();
  await page.goto("/");
  await connect(page);
  await go(page, "PC control");
  await page.getByLabel("Enable manual PC input").check();
  const pad = page.getByRole("application", { name: "PC touchpad" });
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  // A trackpad squeezed to a sliver by the dock is not usable, so its height is
  // part of the regression. Find a point that is genuinely part of the trackpad: on short viewports the
  // dock scrolls, so the geometric centre is not always the visible surface.
  const probe = await page.evaluate(() => {
    const el = document.querySelector(".pc-pad") as HTMLElement | null;
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const hit = (x: number, y: number) => {
      const node = document.elementFromPoint(x, y);
      return Boolean(node && el.contains(node));
    };
    const points: [number, number][] = [];
    for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9])
      for (const fx of [0.5, 0.3, 0.7])
        points.push([r.left + r.width * fx, r.top + r.height * fy]);
    const usable = points.find(([x, y]) => hit(x, y));
    const chain: Record<string, unknown> = {};
    for (const sel of [".pc-page", ".pc-shell", ".pc-stage", ".pc-dock", ".pc-dock-body", ".bottom-nav"]) {
      const node = document.querySelector(sel) as HTMLElement | null;
      if (!node) continue;
      const b = node.getBoundingClientRect();
      chain[sel] = {
        box: [b.left, b.top, b.width, b.height].map(Math.round),
        scroll: [node.clientHeight, node.scrollHeight],
        style: [getComputedStyle(node).flex, getComputedStyle(node).maxHeight, getComputedStyle(node).overflowY],
      };
    }
    return {
      found: true,
      rect: [r.left, r.top, r.width, r.height].map(Math.round),
      view: [window.innerWidth, window.innerHeight, Math.round(window.scrollY)],
      usable: usable ? usable.map(Math.round) : null,
      chain,
    };
  });
  expect(JSON.stringify(probe)).toContain('"usable":[');
  const point = (probe as { usable: number[] }).usable;
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(point[0], point[1]);
  await page.mouse.down();
  for (let step = 0; step < 6; step++) {
    await page.mouse.move(point[0] + step * 12, point[1] + step * 6);
  }
  await page.mouse.up();
  await expect
    .poll(() => f.requests.filter((r) => r.path === "/api/pointer").length)
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("zoom asks for a real crop and taps still land on the right pixel", async ({ page }) => {
  const f = fixture(page);
  await f.install();
  await page.goto("/");
  await connect(page);
  await go(page, "PC control");
  await page.getByLabel("Enable manual PC input").check();
  // Wait for the first frame, then zoom in twice.
  await expect(page.locator(".pc-stage img")).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toHaveText("2.0×");
  await expect
    .poll(() => f.requests.filter((r) => r.path.includes("cx=") && r.path.includes("cw=")).length)
    .toBeGreaterThan(0);
  // At 2.0x the visible region is half the screen in each direction.
  expect(f.requests.some((r) => /cw=500(&|$)/.test(r.path))).toBe(true);
  // A tap in the middle of the visible crop maps to the middle of the PC screen.
  const stage = page.locator(".pc-stage");
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => f.requests.filter((r) => r.path === "/api/tap").length).toBe(1);
  const tap = f.requests.find((r) => r.path === "/api/tap")!;
  expect(Number(tap.body.x)).toBeGreaterThan(400);
  expect(Number(tap.body.x)).toBeLessThan(600);
  // GNOME's screenshots have no pointer in them, so the app draws its own at the
  // place the input actually landed: the middle of a 2x crop is the middle of
  // the screen.
  const ghost = page.locator(".pc-cursor");
  await expect(ghost).toBeVisible();
  const ghostBox = (await ghost.boundingBox())!;
  const stageBox = (await stage.boundingBox())!;
  expect(
    Math.abs(ghostBox.x + ghostBox.width / 2 - (stageBox.x + stageBox.width / 2)),
  ).toBeLessThan(30);
  expect(
    Math.abs(ghostBox.y + ghostBox.height / 2 - (stageBox.y + stageBox.height / 2)),
  ).toBeLessThan(30);
  // A nudge moves the real PC pointer, so the marker has to follow it.
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "Nudge Right" }).click();
  await expect
    .poll(async () => (await ghost.boundingBox())?.x ?? 0)
    .toBeGreaterThan(ghostBox.x + 1);

  // And the tap triggers a fresh frame, so the owner sees the result.
  const screens = f.requests.filter((r) => r.path.startsWith("/api/screen")).length;
  await expect
    .poll(() => f.requests.filter((r) => r.path.startsWith("/api/screen")).length)
    .toBeGreaterThan(screens);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toHaveText("1.0×");
});

test("take over, clipboard and display wake are one tap each", async ({ page }) => {
  const f = fixture(page);
  await f.install();
  await page.goto("/");
  await connect(page);
  await go(page, "PC control");
  await page.getByLabel("Enable manual PC input").check();

  await page.getByRole("tab", { name: "Clip" }).click();
  await page.getByRole("button", { name: "Read PC" }).click();
  await expect(page.getByLabel("Clipboard text")).toHaveValue("copied on the PC");
  await page.getByLabel("Clipboard text").fill("from the phone");
  await page.getByLabel("PC control PIN").fill("5678");
  await page.getByRole("button", { name: "Send to PC" }).click();
  await expect
    .poll(() => f.requests.filter((r) => r.path === "/api/clipboard" && r.body.text === "from the phone").length)
    .toBe(1);

  await page.getByRole("tab", { name: "More" }).click();
  // Exact text on purpose: the status chip above already says "Wayland".
  await expect(page.getByText("wayland", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Wake display" }).first().click();
  await expect.poll(() => f.requests.filter((r) => r.path === "/api/pc/display").length).toBe(1);

  // A busy agent must offer a way out instead of silently refusing input.
  f.pcState.busy = true;
  f.state.active = [{ id: 1, label: "Fixture task", detail: "running", startedAt: Date.now(), elapsedMs: 5 }];
  await go(page, "Chat");
  await go(page, "PC control");
  const takeOver = page.getByRole("button", { name: "Take over" });
  await expect(takeOver).toBeVisible();
  await takeOver.click();
  await expect.poll(() => f.requests.filter((r) => r.path === "/api/chat" && r.body.text === "/stop").length).toBe(1);
  await expect(page.getByLabel("Enable manual PC input")).toBeChecked();
});
