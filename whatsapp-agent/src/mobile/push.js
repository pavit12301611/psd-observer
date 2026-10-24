// Optional FCM HTTP v1. Credentials remain in a private PC file, never the APK.
import fs from 'node:fs';
import { createSign } from 'node:crypto';
export function createPush({ credentialsFile, targets, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let account = null, access = null;
  if (credentialsFile) {
    const stat = fs.lstatSync(credentialsFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000) throw new Error('Invalid push credential file');
    account = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    if (!account.private_key || !account.client_email || !/^[a-z0-9-]{4,100}$/.test(account.project_id)) throw new Error('Invalid push service account');
  }
  const controllerFetch = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(12_000), redirect: 'error' });
  async function token() {
    if (access && access.expires > now()) return access.value;
    const issued = Math.floor(now() / 1000), enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const part = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: issued, exp: issued + 3600 })}`;
    const assertion = part + '.' + createSign('RSA-SHA256').update(part).sign(account.private_key).toString('base64url');
    const response = await controllerFetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    if (!response.ok) throw new Error('Push authentication unavailable'); const body = await response.json();
    if (typeof body.access_token !== 'string') throw new Error('Invalid push access token');
    access = { value: body.access_token, expires: now() + 50 * 60_000 }; return access.value;
  }
  return {
    status: () => ({ configured: Boolean(account), provider: 'fcm', content: 'generic event id/type only' }),
    async send(event) {
      if (!account) return { configured: false };
      const auth = await token(); let delivered = 0;
      for (const device of targets()) {
        const response = await controllerFetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { token: device.token, data: { serverId: String(event.serverId || ''), epoch: String(event.epoch || ''), id: String(event.id), type: String(event.type) }, android: { priority: 'high', ttl: '300s' } } }) });
        if (response.ok) delivered++;
      }
      return { delivered };
    },
  };
}
