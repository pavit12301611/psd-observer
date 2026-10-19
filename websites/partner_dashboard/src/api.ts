const BASE = 'https://api.observer-ai.com';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Call an admin endpoint with the X-Admin-Key header.
 *
 * The admin key is deliberately never persisted anywhere — it lives in React
 * state for the life of the tab and nowhere else. It authorizes org
 * provisioning, which creates real Stripe subscriptions.
 */
export async function adminFetch<T>(
  adminKey: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  return keyedFetch<T>({ 'X-Admin-Key': adminKey }, 'Invalid admin key.', path, init);
}

/**
 * Call a partner endpoint with the X-Partner-Key header. Same handling as the
 * admin key: React state only, never persisted.
 */
export async function partnerFetch<T>(
  partnerKey: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  return keyedFetch<T>({ 'X-Partner-Key': partnerKey }, 'Invalid partner key.', path, init);
}

async function keyedFetch<T>(
  keyHeader: Record<string, string>,
  forbiddenMessage: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...keyHeader,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(response.status, forbiddenMessage);
    }
    const detail =
      data && typeof data === 'object' && 'detail' in data
        ? String((data as { detail: unknown }).detail)
        : `Request failed (${response.status}).`;
    throw new ApiError(response.status, detail);
  }

  return data as T;
}
