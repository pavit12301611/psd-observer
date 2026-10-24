// Native-system credential automation for a disposable emulator only. Never
// enter into app/web content, retry a PIN, or fake authentication success.
const systemPackages = new Set(['com.android.settings', 'com.android.systemui', 'android']);
export function credentialNodes(xml) {
  return [...String(xml).matchAll(/<node\b([^>]*)\/?\s*>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]])));
}
export function credentialTarget(xml) {
  const nodes = credentialNodes(xml).filter((n) => systemPackages.has(n.package));
  const entry = nodes.find((n) => /EditText/i.test(n.class || '') && (n.password === 'true' || /password|pin.?entry/i.test(n['resource-id'] || '')));
  if (entry) return { kind: 'entry', node: entry };
  const fallback = nodes.find((n) => n.clickable === 'true' && /use.*(?:pin|password|screen lock|device credential)/i.test(`${n.text || ''} ${n['content-desc'] || ''}`));
  return fallback ? { kind: 'fallback', node: fallback } : null;
}
export function center(node) {
  const b = String(node.bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!b || Number(b[3]) <= Number(b[1]) || Number(b[4]) <= Number(b[2])) throw new Error('Invalid system credential control bounds');
  return { x: Math.floor((Number(b[1]) + Number(b[3])) / 2), y: Math.floor((Number(b[2]) + Number(b[4])) / 2) };
}
export async function enterEmulatorCredential({ readTree, tap, typeOnce, submit, now = Date.now, delay = (ms) => new Promise((r) => setTimeout(r, ms)), timeout = 25000 }) {
  const deadline = now() + timeout; let selectedFallback = false;
  while (now() < deadline) {
    const target = credentialTarget(await readTree());
    if (target?.kind === 'fallback' && !selectedFallback) { selectedFallback = true; await tap(center(target.node)); }
    if (target?.kind === 'entry') {
      await tap(center(target.node)); await typeOnce(); await submit();
      return; // Never retry a credential or clear/replace a failed attempt.
    }
    await delay(300);
  }
  throw new Error('No system credential entry became ready; no PIN was typed into app content');
}
