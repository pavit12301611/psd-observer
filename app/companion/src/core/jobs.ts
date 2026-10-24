import type { Job, JobRef } from "../types";
import { api, ApiError, SessionChanged } from "./api";
import { isNative, nativeCall } from "./native";
const key = "observer-pending-jobs";
let writes: Promise<unknown> = Promise.resolve();
export async function pendingJobs(): Promise<JobRef[]> {
  try {
    const raw = isNative()
      ? await nativeCall<string>("readPendingJobs")
      : localStorage.getItem(key);
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list)
      ? list
          .filter(
            (r) =>
              r &&
              typeof r.id === "string" &&
              typeof r.conversationId === "string",
          )
          .slice(-40)
      : [];
  } catch {
    return [];
  }
}
async function update(fn: (refs: JobRef[]) => JobRef[]) {
  const task = writes.then(async () => {
    const refs = fn(await pendingJobs());
    const value = JSON.stringify(refs);
    if (isNative()) await nativeCall("writePendingJobs", { value });
    else localStorage.setItem(key, value);
  });
  writes = task.catch(() => {});
  await task;
}
export const rememberJob = (ref: JobRef) =>
  update((refs) => [...refs.filter((r) => r.id !== ref.id), ref].slice(-40));
export const clearPendingJobs = () => update(() => []);
export const forgetJob = (id: string) =>
  update((refs) => refs.filter((r) => r.id !== id));
export class PendingJob extends Error {
  constructor(
    public id: string,
    message = "Connection interrupted. The request ID is saved; recover its result from Tasks. No action was resent.",
  ) {
    super(message);
  }
}
export async function submitAndWatch(
  payload: Record<string, unknown> & { id: string },
  options: {
    onState?: (job: Job) => void;
    foregroundOnly?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const epoch = api.generation;
  try {
    const job = await api.post<Job>("/api/app/jobs", payload);
    options.onState?.(job);
    if (job.result) return job;
  } catch (e) {
    if (
      e instanceof SessionChanged ||
      (e instanceof ApiError &&
        [400, 401, 403, 409, 413, 423].includes(e.status))
    )
      throw e;
  }
  // Only read the stable ID from here on. Never automatically repeat POST/actions.
  return watchJob(payload.id, { ...options, epoch });
}
export async function watchJob(
  id: string,
  options: {
    onState?: (job: Job) => void;
    foregroundOnly?: boolean;
    signal?: AbortSignal;
    epoch?: number;
  } = {},
): Promise<Job> {
  const epoch = options.epoch ?? api.generation;
  let failures = 0;
  while (!options.signal?.aborted) {
    if (epoch !== api.generation) throw new SessionChanged();
    if (options.foregroundOnly !== false && document.hidden)
      throw new PendingJob(
        id,
        "App backgrounded. Your PC can continue; the saved request ID can recover its result.",
      );
    try {
      const job = await api.job(id);
      failures = 0;
      options.onState?.(job);
      if (["replied", "unknown", "cancelled", "rejected"].includes(job.state))
        return job;
    } catch (e) {
      if (
        e instanceof SessionChanged ||
        (e instanceof ApiError && e.status === 401)
      )
        throw e;
      if (e instanceof ApiError && e.status === 404)
        throw new PendingJob(
          id,
          "No retained record was found. Inspect Tasks/PC before a new request; nothing was replayed.",
        );
      if (++failures >= 3) throw new PendingJob(id);
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        failures ? Math.min(5000, 1000 * 2 ** failures) : 1400,
      ),
    );
  }
  throw new PendingJob(id);
}
