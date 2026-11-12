// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue identity bridge only. Claims and execution stay in the decision API.
import type { ProducerBindings, ProducerQueuePort } from './types.ts';
const ports = new Map<string, ProducerQueuePort>();
let installed: { bindings: ProducerBindings; removers: Map<ProducerQueuePort, () => void> } | undefined;
export function trackProducerQueue(port: ProducerQueuePort): void {
  const old = ports.get(port.kind);
  if (old === port) return;
  if (installed && old) throw new Error('duplicate-producer-queue');
  const remove = installed?.bindings.registerQueue(port);
  ports.set(port.kind, port);
  if (remove) installed!.removers.set(port, remove);
}
export function bindProducers(bindings: ProducerBindings): () => void {
  if (installed) throw new Error('producer-bindings-already-installed');
  const own = { bindings, removers: new Map<ProducerQueuePort, () => void>() };
  try { for (const port of ports.values()) own.removers.set(port, bindings.registerQueue(port)); }
  catch (error) { for (const remove of own.removers.values()) remove(); throw error; }
  installed = own;
  return () => { if (installed === own) { installed = undefined; for (const remove of own.removers.values()) remove(); } };
}
export function producerBindings(): ProducerBindings | undefined { return installed?.bindings; }
export function trackedProducerQueue(kind: string): ProducerQueuePort | undefined { return ports.get(kind); }
