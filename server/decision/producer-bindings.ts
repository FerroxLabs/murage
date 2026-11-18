// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue identity bridge only. Claims and execution stay in the decision API.
import type { ProducerBindings, ProducerQueuePort, ProvenanceReader, TurnIdentity } from './types.ts';
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

// Keep source lineage internal; the frozen public turn-policy contract grants no presentation metadata.
let turnReader: ProvenanceReader | undefined;
export function bindProducerTurnReader(reader: ProvenanceReader): void { turnReader = reader; }
// A synthetic service context (routine offer, No limits) reads no live turn; its source turn is registered by generation.
const sourceTurns = new Map<string, string>();
export function bindProducerSourceTurn(generation: string, turnId: string | undefined): () => void {
  if (!turnId) return () => {};
  sourceTurns.set(generation, turnId);
  return () => { if (sourceTurns.get(generation) === turnId) sourceTurns.delete(generation); };
}
export function producerTurnId(identity: TurnIdentity | undefined): string | undefined {
  if (!identity?.threadId || !identity.generation || !turnReader || turnReader.turnGenerationFor(identity.threadId) !== identity.generation) return;
  return turnReader.live(identity.threadId)?.turnId || sourceTurns.get(identity.generation);
}
