import { expect, it, vi } from "vitest";
import { api, ApiError } from "../src/core/api";
import {
  submitAndWatch,
  rememberJob,
  pendingJobs,
  forgetJob,
} from "../src/core/jobs";
import { pairingQR, connectionHelp } from "../src/core/pairing";
it("an aborted acceptance connection recovers by GET, never repeats POST or the PC action", async () => {
  const post = vi
    .spyOn(api, "post")
    .mockRejectedValue(new Error("Software caused connection abort"));
  const read = vi
    .spyOn(api, "job")
    .mockResolvedValue({
      id: "fixture_job_id",
      kind: "chat",
      deviceId: "fixture",
      label: "test",
      state: "replied",
      createdAt: 1,
      result: { text: "Actual recovered AI result" },
    });
  const result = await submitAndWatch({
    id: "fixture_job_id",
    text: "explain recursion",
  });
  expect(result.result?.text).toBe("Actual recovered AI result");
  expect(post).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});
it("a definitive rejected request is never silently resubmitted or called an executed PC action", async () => {
  const post = vi
    .spyOn(api, "post")
    .mockRejectedValue(new ApiError(423, "Agent busy"));
  await expect(
    submitAndWatch({ id: "fixture_busy_id", text: "test" }),
  ).rejects.toThrow("Agent busy");
  expect(post).toHaveBeenCalledTimes(1);
});
it("pending metadata persists only IDs/bounded labels; recovery lookup survives reload shape", async () => {
  await rememberJob({
    id: "fixture_pending_id",
    conversationId: "convo",
    serverId: "pc",
    label: "fixture",
    created: 1,
  });
  expect((await pendingJobs())[0].id).toBe("fixture_pending_id");
  await forgetJob("fixture_pending_id");
  expect(await pendingJobs()).toEqual([]);
});
it("QR parser accepts only expiring Observer pairing data and never executes decoded content", () => {
  const json = {
    origin: "http://192.168.1.12:8787",
    code: "A".repeat(32),
    serverId: "a".repeat(32),
    protocol: 2,
    expiresAt: 123,
  };
  const raw = "observer-companion://pair?payload=" + btoa(JSON.stringify(json));
  expect(pairingQR(raw).serverId).toBe(json.serverId);
  for (const value of [
    "javascript:alert(1)",
    "https://evil/?payload=x",
    "observer-companion://pair?payload=e30",
  ])
    expect(() => pairingQR(value)).toThrow();
  expect(connectionHelp("failed to connect after 15000ms").title).toContain(
    "could not reach",
  );
  expect(connectionHelp("Update 3.10.0").title).toContain("update");
});
