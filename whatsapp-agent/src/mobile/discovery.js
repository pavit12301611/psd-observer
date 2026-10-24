import { records, error } from './records.js';
export function createDiscovery({ file, host, port, serverId, version, enabled = false, factory } = {}) {
  const db = records(file, { schema: 1, enabled }); let instance = null, advertisement = null;
  return {
    status: () => ({ enabled: db.value.enabled, advertising: Boolean(advertisement), service: '_observer._tcp', note: 'Metadata only; a PIN/one-time QR is still required. No firewall settings are changed.' }),
    async set(value) {
      if (typeof value !== 'boolean') throw error(400, 'Explicit boolean required');
      if (value && host === '127.0.0.1') throw error(409, 'Bridge is loopback-only. Review HOST on the PC before advertising.');
      if (advertisement) { advertisement.stop(); advertisement = null; } instance?.destroy(); instance = null;
      if (value) { const create = factory || (() => import('bonjour-service').then(({ Bonjour }) => new Bonjour())); instance = await create(); advertisement = instance.publish({ name: 'Observer PC', type: 'observer', port, txt: { serverId, version, protocol: '2' } }); advertisement.on?.('error', () => {}); }
      db.update((s) => ({ ...s, enabled: value })); return this.status();
    },
    async start() { if (db.value.enabled) await this.set(true); },
    close() { advertisement?.stop(); instance?.destroy(); advertisement = null; instance = null; },
  };
}
