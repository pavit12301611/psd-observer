import { version as appVersion } from '../../package.json';
import type { Profile, Release, WireResponse } from '../types';
import { isNative, nativeCall, openExternal } from './native';
import { safeApiPath, validateBase } from './validation';
export class SessionChanged extends Error { constructor() { super('Session changed. Late results were discarded.'); } }
export class BridgeClient {
  profile: Profile | null = null; private token = ''; private epoch = 0;
  private requests = new Set<AbortController>();
  onSessionLost: (() => void) | null = null;
  async restore() { const generation = this.epoch; if (isNative()) { const restored = await nativeCall<Profile | null>('restore'); if (generation !== this.epoch) throw new SessionChanged(); this.profile = restored; } return this.profile; }
  async pair(raw: string, pin: string, allowLan: boolean) {
    const baseUrl = validateBase(raw, allowLan), generation = ++this.epoch;
    if (!pin.trim()) throw new Error('Enter the dashboard PIN from your PC.');
    if (isNative()) {
      const p = await nativeCall<Profile>('pair', { baseUrl, pin, allowLan });
      if (generation !== this.epoch) throw new SessionChanged(); this.profile = p;
    } else {
      const res = await fetch('/bridge/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }), cache: 'no-store', redirect: 'error' });
      const data = await res.json().catch(() => ({}));
      if (generation !== this.epoch) throw new SessionChanged();
      if (!res.ok || !data.token) throw new Error(data.detail || 'PC bridge unavailable. Configure OBSERVER_BRIDGE_TARGET for browser preview.');
      const capabilityResponse = await fetch('/bridge/api/app/state', { headers: { 'x-bridge-token': data.token }, cache: 'no-store', redirect: 'error' });
      const capabilities = await capabilityResponse.json().catch(() => ({}));
      if (generation !== this.epoch) throw new SessionChanged();
      if (!capabilityResponse.ok || capabilities.apiVersion !== 1 || !Array.isArray(capabilities.active) || !Array.isArray(capabilities.pending)) throw new Error('Update the PC agent to 3.9.2+ from this branch before pairing. This app requires the structured, scoped mobile API.');
      this.token = data.token; this.profile = { baseUrl: 'Browser bridge proxy', native: false };
    }
    return this.profile;
  }
  async disconnect() {
    this.epoch++; this.requests.forEach((c) => c.abort()); this.requests.clear(); this.token = ''; this.profile = null;
    if (isNative()) await nativeCall('logout');
  }
  async wire(path: string, options: { method?: string; body?: unknown; binary?: boolean; timeout?: number; headers?: Record<string, string> } = {}): Promise<WireResponse> {
    safeApiPath(path); if (!this.profile) throw new Error('Connect your PC first.');
    const generation = this.epoch;
    let result: WireResponse;
    if (isNative()) result = await nativeCall<WireResponse>('request', { path, ...options }, options.timeout || 240_000);
    else {
      const controller = new AbortController(); this.requests.add(controller);
      const timer = setTimeout(() => controller.abort(), options.timeout || 240_000);
      try {
        const response = await fetch('/bridge' + path, { method: options.method || 'GET', headers: { 'x-bridge-token': this.token, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined, cache: 'no-store', redirect: 'error', signal: controller.signal });
        result = { status: response.status, headers: Object.fromEntries(response.headers.entries()), mime: response.headers.get('content-type') || '' };
        if (options.binary && response.ok) {
          const blob = await response.blob();
          result.base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
        } else result.json = await response.json().catch(() => ({}));
      } finally { clearTimeout(timer); this.requests.delete(controller); }
    }
    if (generation !== this.epoch) throw new SessionChanged();
    if (result.status === 401) { await this.disconnect(); this.onSessionLost?.(); throw new Error('Session expired. Pair your PC again.'); }
    if (result.status >= 400) throw new Error((result.json as { detail?: string })?.detail || `PC returned ${result.status}`);
    return result;
  }
  async get<T>(path: string) { return (await this.wire(path)).json as T; }
  async post<T>(path: string, body: unknown) { return (await this.wire(path, { method: 'POST', body })).json as T; }
  async download(path: string, name: string) {
    safeApiPath(path);
    if (isNative()) return nativeCall('download', { path, name });
    const result = await this.wire(path, { binary: true });
    const blob = base64Blob(result.base64 || '', result.mime || 'application/octet-stream');
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
export const api = new BridgeClient();
export function base64Blob(base64: string, mime: string): Blob {
  const data = atob(base64), bytes = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i); return new Blob([bytes], { type: mime });
}
export function updateCandidate(releases: Release[], current = appVersion) {
  const tuple = (v: string) => v.split('.').map(Number);
  const newer = (v: string) => { const a = tuple(v), b = tuple(current); for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; };
  return releases.filter((r) => !r.draft && !r.prerelease && /^android-v\d+\.\d+\.\d+$/.test(r.tag_name) && newer(r.tag_name.slice(9)) && r.assets.some((a) => a.name.endsWith('.apk'))).sort((a, b) => {
    const x = tuple(a.tag_name.slice(9)), y = tuple(b.tag_name.slice(9)); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0] || null;
}
export async function checkUpdates() {
  const releases = isNative() ? await nativeCall<Release[]>('checkUpdates') : await fetch('/release-api/repos/pavit12301611/psd-observer/releases?per_page=30', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('Could not check official releases. Try again later.'); return r.json(); });
  if (!Array.isArray(releases)) throw new Error('Invalid release metadata');
  return updateCandidate(releases);
}
export const openRelease = (release: Release) => {
  if (!release.html_url.startsWith('https://github.com/pavit12301611/psd-observer/releases/')) throw new Error('Unofficial release URL blocked');
  openExternal(release.html_url);
};
