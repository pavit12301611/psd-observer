import type { Message, Reply } from '../types';
import { nativeCall } from './native';
export interface CloudStatus { configured: boolean; provider?: string; model?: string }
let epoch = 0;
export async function cloudStatus() { return nativeCall<CloudStatus>('cloudStatus'); }
export async function configureCloud(provider: string, model: string, key: string) { epoch++; return nativeCall<CloudStatus>('configureCloud', { provider, model, key }); }
export async function cancelCloud() { epoch++; return nativeCall('cancelCloud'); }
export async function clearCloud() { epoch++; return nativeCall('clearCloud'); }
export async function cloudChat(messages: Message[]): Promise<Reply> {
  const generation = epoch;
  const reply = await nativeCall<Reply>('cloudChat', { messages: messages.filter((m) => !m.private).slice(-12).map((m, i, all) => ({ role: m.role, content: m.text.slice(0, i === all.length - 1 ? 16000 : 1800) })) }, 120_000);
  if (generation !== epoch) throw new Error('Cloud configuration changed. Late result discarded.');
  return reply;
}
