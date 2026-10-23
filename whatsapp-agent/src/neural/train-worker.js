// Dedicated CPU worker: training must never freeze WhatsApp or /stop.
import { parentPort, workerData } from 'node:worker_threads';
import { trainAll } from './train.js';
if (parentPort) {
  const { checkpoint, metrics } = trainAll({ ...workerData, includeRuntime: true });
  parentPort.postMessage({ checkpoint, metrics });
}
