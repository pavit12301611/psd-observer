import { describe, expect, it, vi } from 'vitest';
import { validateBase, safeApiPath, relativePoint, displayRequest, privateHost, MAX_UPLOAD, attachment } from '../src/core/validation';
import { normaliseState, persistentState, emptyState } from '../src/core/storage';
import { updateCandidate, BridgeClient } from '../src/core/api';
import catalog from '../src/data/commands.json';
import type { Release } from '../src/types';

describe('connection policy', () => {
  it.each(['http://example.com', 'http://127.0.0.1:8787', 'https://localhost:8787', 'https://[::1]', 'file:///a', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/?t=private', 'https://example.com/#token', 'https://example.com/private'])('rejects unsafe address %s', (address) => { expect(() => validateBase(address, true)).toThrow(); });
  it('requires explicit opt-in for private HTTP; permits valid HTTPS', () => {
    expect(() => validateBase('192.168.1.5:8787', false)).toThrow();
    expect(validateBase('192.168.1.5:8787', true)).toBe('http://192.168.1.5:8787');
    expect(validateBase('https://pc.example/', false)).toBe('https://pc.example');
    expect(validateBase('http://100.64.1.2:8787', true)).toBe('http://100.64.1.2:8787');
  });
  it('does not confuse public, loopback, suffix hosts or invalid IPv4 with private networks', () => {
    for (const h of ['10.evil.com', '10.300.0.1', '100.128.0.1', '172.32.1.1', '127.0.0.1', '192.169.1.2', '10.0.0.1.example']) expect(privateHost(h)).toBe(false);
    for (const h of ['10.0.0.1', '192.168.0.1', '172.16.0.1', '100.64.1.1', '[fd00::1]']) expect(privateHost(h)).toBe(true);
  });
  it.each(['https://evil.com/api/chat', '//evil.com/api/chat', '/api/../secret', '/api/chat\r\nfoo', '/api/\\evil', '/api/chat#x', '/api/%2e%2e/secret'])('blocks path/credential exfiltration %s', (p) => expect(() => safeApiPath(p)).toThrow());
  it('allows authenticated relative API paths including encoded file query values', () => expect(safeApiPath('/api/download?path=%2Fhome%2Fuser%2Fa%20b.txt')).toBe('/api/download?path=%2Fhome%2Fuser%2Fa%20b.txt'));
});
describe('mobile correctness and privacy', () => {
  it('maps contain-fit screen pixels correctly, excludes letterboxes and never emits outside-edge 1000', () => {
    const r = { left: 0, top: 0, width: 400, height: 400 }, image = { width: 1920, height: 1080 };
    expect(relativePoint(200, 200, r, image)).toEqual({ x: 500, y: 500, relative: true });
    expect(relativePoint(200, 30, r, image)).toBeNull();
    expect(relativePoint(400, 200, r, image)).toBeNull();
    expect(relativePoint(399.99, 200, r, image)?.x).toBe(999);
    expect(relativePoint(10, 10, { ...r, width: 0 }, image)).toBeNull();
  });
  it('never stores PIN/key-bearing command text in user-visible history', () => {
    for (const text of ['/run 1234 ls', '/pc type 1234 secret', '/mail setup server user password', '/dsh key secret']) { const d = displayRequest(text); expect(d.private).toBe(true); expect(d.text).not.toContain('secret'); expect(d.text).not.toContain('1234'); }
    expect(displayRequest('/time')).toEqual({ text: '/time', private: false });
  });
  it.each([null, [], {}, { conversations: null }, { conversations: [null, { messages: [] }] }, { preferences: { theme: 'garbage' } }])('boots safely from malformed state %#', (raw) => {
    const s = normaliseState(raw); expect(s.conversations.length).toBeGreaterThan(0); expect(['light', 'dark', 'system']).toContain(s.preferences.theme);
  });
  it('bounds stored history, strips media, raw HTML is plain text, and removes private turns', () => {
    const s = emptyState(); s.conversations[0].messages = [{ id: 'a', role: 'user', text: 'private', private: true, ts: 1 }, { id: 'b', role: 'assistant', text: '<script>unsafe</script>', images: ['large-base64'], audio: 'large', ts: 1 }];
    const saved = persistentState(s); expect(saved.conversations[0].messages).toHaveLength(1); expect(saved.conversations[0].messages[0].images).toBeUndefined(); expect(saved.conversations[0].messages[0].text).toBe('<script>unsafe</script>');
    s.preferences.saveHistory = false; expect(persistentState(s).conversations[0].messages).toEqual([]);
  });
  it('rejects unsupported, oversized and empty attachment files', async () => {
    await expect(attachment(new File([], 'empty.txt', { type: 'text/plain' }))).rejects.toThrow();
    await expect(attachment(new File(['x'], 'a.exe', { type: 'application/octet-stream' }))).rejects.toThrow();
    const large = new File([new Uint8Array(MAX_UPLOAD + 1)], 'x.png', { type: 'image/png' }); await expect(attachment(large)).rejects.toThrow('8 MB');
  });
  it('has a deduplicated actual public agent catalog, including safety, voice, learning and batch commands', () => {
    expect(catalog.commands.length).toBeGreaterThan(140);
    for (const name of ['/batch', '/shades', '/panic', '/trash', '/neural', '/mail', '/solve', '/call']) expect(catalog.commands.some((c) => c.name === name)).toBe(true);
    expect(new Set(catalog.commands.map((c) => c.name)).size).toBe(catalog.commands.length);
  });
});
it('update selection is semver-aware, Android-only, excludes drafts/prereleases and requires an APK', () => {
  const r = (version: string, override = {}): Release => ({ tag_name: version, html_url: 'https://github.com/pavit12301611/psd-observer/releases/tag/' + version, assets: [{ name: 'observer.apk', size: 1, browser_download_url: 'unused' }], ...override });
  expect(updateCandidate([r('v9.0.0'), r('android-v1.2.0'), r('android-v1.10.0'), r('android-v2.0.0', { draft: true }), r('android-v3.0.0', { assets: [] })])?.tag_name).toBe('android-v1.10.0');
  expect(updateCandidate([r('android-v1.0.0'), r('android-v9.0.0', { prerelease: true })])).toBeNull();
});
it('late replies from a disconnected browser session cannot mutate a fresh session; credentials never go in URLs/storage', async () => {
  const client = new BridgeClient(); let finish!: (r: Response) => void; const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    seen.push(url); if (url.endsWith('/login')) return new Response(JSON.stringify({ token: 'fixture-private-token' }), { status: 200 });
    expect((options?.headers as Record<string, string>)['x-bridge-token']).toBe('fixture-private-token'); return await new Promise<Response>((r) => { finish = r; });
  }));
  await client.pair('https://pc.example', '123456', false);
  const pending = client.get('/api/status'); const assertion = expect(pending).rejects.toThrow('Session changed');
  await client.disconnect(); finish(new Response('{}', { status: 401 })); await assertion;
  expect(client.profile).toBeNull(); expect(seen.every((url) => url.startsWith('/bridge/') && !url.includes('fixture-private'))).toBe(true); expect(localStorage.length).toBe(0);
  vi.unstubAllGlobals();
});
it('a late native restore cannot replace a newly paired profile', async () => {
  const packets: { id: string; method: string }[] = [];
  window.ObserverAndroid = { postMessage: (raw) => packets.push(JSON.parse(raw)) };
  const result = (id: string, data: unknown) => window.dispatchEvent(new CustomEvent('observer-native-result', { detail: { id, ok: true, data } }));
  const client = new BridgeClient(); const pending = client.restore(); const rejected = expect(pending).rejects.toThrow('Session changed');
  const paired = client.pair('https://pc.example', '123456', false);
  result(packets.find((p) => p.method === 'pair')!.id, { baseUrl: 'https://pc.example', native: true }); await paired;
  result(packets.find((p) => p.method === 'restore')!.id, { baseUrl: 'https://old.example' }); await rejected;
  expect(client.profile?.baseUrl).toBe('https://pc.example'); delete window.ObserverAndroid;
});
