// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { RequestDelivery } from '../contracts.ts';

export function inputHash(value: unknown): string {
 const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
 return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
}
type Entry = { answerId: string; hash: string; state: 'pending' | 'accepted' | 'failed'; attempts: number;
 done: Promise<RequestDelivery>; retire?: () => void };
/** Open native requests are present state. Only closed history has a retention cap. */
export class AnswerDelivery {
 private active = new Map<string, Map<string, Entry>>();
 private terminal = new Map<string, Entry>();
 private openCount = 0;
 get size() { return this.openCount + this.terminal.size; }
 deliver(generation: string, requestId: string, answerId: string, answer: unknown, send: () => Promise<boolean>): Promise<RequestDelivery> {
  const key = JSON.stringify([generation, requestId]), hash = inputHash(answer);
  let bucket = this.active.get(generation);
  let entry = bucket?.get(requestId) ?? this.terminal.get(key);
  if (entry) {
   if (entry.answerId !== answerId || entry.hash !== hash) return Promise.resolve({ state: 'failed' });
   if (entry.state === 'pending') return entry.done;
   if (this.terminal.has(key)) { this.terminal.delete(key); this.terminal.set(key, entry); }
   if (entry.state === 'accepted') return Promise.resolve({ state: 'already' });
   if (this.terminal.has(key)) return Promise.resolve({ state: 'failed' });
  } else {
   if (!bucket) { bucket = new Map(); this.active.set(generation, bucket); }
   entry = { answerId, hash, state: 'pending', attempts: 0, done: undefined! };
   bucket.set(requestId, entry); this.openCount++;
  }
  const current = entry; current.state = 'pending'; current.attempts++;
  current.done = new Promise<RequestDelivery>(resolve => {
   const finish = (ok: boolean) => {
    if (current.state !== 'pending') return;
    current.state = ok ? 'accepted' : 'failed'; current.retire = undefined;
    resolve({ state: current.state });
   };
   current.retire = () => finish(false);
   void Promise.resolve().then(() => current.state === 'pending' ? send() : false).then(finish, () => finish(false));
  });
  return current.done;
 }
 close(generation: string, requestId: string) {
  const bucket = this.active.get(generation), entry = bucket?.get(requestId);
  if (!bucket || !entry) return;
  bucket.delete(requestId); this.openCount--;
  if (!bucket.size) this.active.delete(generation);
  entry.retire?.();
  this.terminal.set(JSON.stringify([generation, requestId]), entry);
  while (this.terminal.size > 1024) this.terminal.delete(this.terminal.keys().next().value!);
 }
 retire(generation: string) {
  const bucket = this.active.get(generation);
  if (bucket) for (const requestId of bucket.keys()) this.close(generation, requestId);
 }
}
