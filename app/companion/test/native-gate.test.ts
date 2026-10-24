import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/core/api";

/**
 * The Android bridge runs every HTTP call on a small thread pool and *rejects*
 * the surplus. One rejected pointer move used to look like a dead page, so the
 * web bundle must never queue more than a handful of calls and must retry a
 * rejection once instead of showing the pool's internals.
 */

type Posted = { id: string; method: string; payload: Record<string, unknown> };

const posted: Posted[] = [];

const answer = (id: string, ok: boolean, data: unknown = {}) =>
  window.dispatchEvent(
    new CustomEvent("observer-native-result", {
      detail: JSON.stringify(ok ? { id, ok, data } : { id, ok, error: data }),
    }),
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function client() {
  const c = new BridgeClient();
  // A paired client, without going through the pairing screen.
  (c as unknown as { profile: unknown }).profile = {
    baseUrl: "http://127.0.0.1:8787",
    token: "fixture-token",
  };
  return c;
}

beforeEach(() => {
  posted.length = 0;
  (window as unknown as { ObserverAndroid: unknown }).ObserverAndroid = {
    postMessage: (json: string) => posted.push(JSON.parse(json) as Posted),
  };
});

afterEach(() => {
  delete (window as unknown as { ObserverAndroid?: unknown }).ObserverAndroid;
});

describe("native request gate", () => {
  it("keeps at most three calls in flight, queueing the rest", async () => {
    const api = client();
    const calls = Array.from({ length: 5 }, () =>
      api.wire("/api/pointer", { method: "POST", body: { op: "click" } }),
    );
    await settle();
    expect(posted).toHaveLength(3);
    answer(posted[0].id, true, { status: 200, headers: {}, json: { ok: true } });
    await settle();
    expect(posted).toHaveLength(4);
    answer(posted[1].id, true, { status: 200, headers: {}, json: { ok: true } });
    answer(posted[2].id, true, { status: 200, headers: {}, json: { ok: true } });
    await settle();
    expect(posted).toHaveLength(5);
    for (const call of posted)
      answer(call.id, true, { status: 200, headers: {}, json: { ok: true } });
    await expect(Promise.all(calls)).resolves.toHaveLength(5);
  });

  it("retries once when the bridge pool rejects, instead of failing input", async () => {
    const api = client();
    const call = api.wire("/api/tap", { method: "POST", body: { x: 500, y: 500 } });
    await settle();
    expect(posted).toHaveLength(1);
    answer(
      posted[0].id,
      false,
      "Task in.observer.companion.MainActivity$AndroidBridge$$ExternalSyntheticLambda12@4eb295f rejected from java.util.concurrent.ThreadPoolExecutor@2248739[Running, pool size = 4, active threads = 4, queued tasks = 12, completed tasks = 31]",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(posted).toHaveLength(2); // retried, not surfaced
    answer(posted[1].id, true, { status: 200, headers: {}, json: { ok: true } });
    await expect(call).resolves.toMatchObject({ status: 200 });
  });

  it("still surfaces real refusals (a 423 busy PC) to the caller", async () => {
    const api = client();
    const call = api.wire("/api/tap", { method: "POST", body: { x: 1, y: 1 } });
    await settle();
    answer(posted[0].id, true, {
      status: 423,
      headers: {},
      json: { detail: "Stop or wait for the active agent task." },
    });
    await expect(call).rejects.toThrow(/active agent task/);
    expect(posted).toHaveLength(1); // a policy refusal is not retried
  });
});
