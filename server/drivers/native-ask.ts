// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export type AskMode = 'answer' | 'retire';
export interface NativeAskSlot { writing?: Promise<boolean>; frameKey?: string; closed: boolean }
/** Keep the native ask and its timer until a write receipt, transport loss, or retirement.
 * A retirement racing a write joins that write and commits its result exactly once. */
export function deliverNative(slot: NativeAskSlot, mode: AskMode, frameKey: string,
 write: () => Promise<boolean>, writable: () => boolean, commit: (accepted: boolean) => void, canWrite: () => boolean = () => true): Promise<boolean> {
 if (slot.closed) return Promise.resolve(false);
 if (slot.writing) {
  const writing = slot.writing;
  if (mode === 'retire') {
   // Retirement never writes a competing frame. The outstanding callback
   // still owns acceptance; a failed callback closes with the retirement source.
   void writing.then(ok => { if (!slot.closed) { slot.closed = true; commit(ok); } });
  }
  return slot.frameKey === frameKey ? writing : Promise.resolve(false);
 }
 slot.frameKey = frameKey;
 // Install the promise before invoking a possibly reentrant write.
 let held=false;
 const writing = Promise.resolve().then(()=>{if(!canWrite()){held=true;return false;}return write();}).catch(() => false).then(ok => {
  if (!held && !slot.closed && (ok || mode === 'retire' || !writable())) { slot.closed = true; commit(ok); }
  return ok;
 }).finally(() => { if (slot.writing === writing) { slot.writing = undefined; slot.frameKey = undefined; } });
 slot.writing = writing;
 return writing;
}
