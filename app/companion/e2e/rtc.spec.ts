import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Actual Node signaling/auth code, synthetic canvas capture, never real desktop input.
// @ts-expect-error JavaScript backend has its own Node tests, no TS declarations.
import { createBridgeServer } from "../../../whatsapp-agent/src/server.js";
test("real WebRTC signaling receives synthetic video with an authenticated device, no screen permission bypass", async ({
  browser,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Protocol video is exercised once; other tests cover all responsive layouts.",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-rtc-e2e-"));
  const bridge = createBridgeServer({
    config: {
      dataDir: dir,
      host: "127.0.0.1",
      port: 8787,
      bridgeToken: "rtc-fixture-owner-token",
      dashboardPin: "123456",
      allowPcControl: true,
      ownerNumber: "919999999999",
      agentNumber: "918888888888",
    },
    store: { data: { stats: {}, reminders: [], todos: [], notes: [] } },
    whatsapp: { status: () => "fixture only", state: {} },
    mailbox: { observerOnline: () => false },
    actions: {},
    app: { state: () => ({ active: [], pending: [] }), busy: () => false },
    runOwner: async () => "fixture only",
    screen: {
      capture: async () => Buffer.alloc(0),
      key: async () => {},
      type: async () => {},
      click: async () => {},
    },
    log: { info() {}, error() {} },
  });
  const server = await bridge.start();
  const pc = await browser.newPage();
  const phone = await browser.newPage({
    viewport: { width: 412, height: 915 },
  });
  try {
    await pc.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        value: async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          let n = 0;
          const ctx = canvas.getContext("2d")!;
          const draw = () => {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = "#fff";
            ctx.font = "30px sans-serif";
            ctx.fillText("SYNTHETIC CI FRAME " + n++, 30, 160);
          };
          draw();
          setInterval(draw, 150);
          return canvas.captureStream(6);
        },
      });
    });
    await pc.goto("http://127.0.0.1:8787/desktop");
    await pc.locator("#pin").fill("123456");
    await pc.getByRole("button", { name: "Unlock this PC session" }).click();
    await pc
      .getByRole("button", { name: "Choose screen & arm sharing" })
      .click();
    await expect(pc.locator("#status")).toContainText("armed");
    await phone.goto("/");
    await phone
      .getByRole("button", { name: "Connect PC", exact: true })
      .click();
    await phone
      .getByLabel("PC bridge address")
      .fill("http://192.168.1.12:8787");
    await phone.getByLabel("Dashboard PIN").fill("123456");
    await phone.getByRole("checkbox").check();
    await phone.getByRole("button", { name: "Connect my PC" }).click();
    await expect(
      phone.getByRole("button", { name: "PC connected", exact: true }),
    ).toBeVisible();
    await phone
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("button", { name: "PC control", exact: true })
      .click();
    // Live video lives in the More tab of the control dock.
    await phone.getByRole("tab", { name: "More" }).click();
    await phone
      .getByRole("button", { name: "Connect live video", exact: true })
      .click();
    await expect
      .poll(
        () =>
          phone
            .locator(".live-desktop")
            .evaluate(
              (v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0,
            ),
        { timeout: 15000 },
      )
      .toBe(true);
    await phone
      .getByRole("button", { name: "Stop video", exact: true })
      .click();
    await expect(pc.locator("#status")).toContainText("no live viewer", {
      timeout: 5000,
    });
  } finally {
    await pc.close();
    await phone.close();
    server.closeAllConnections();
    bridge.stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
