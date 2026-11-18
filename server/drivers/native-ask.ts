// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export type AskMode = 'answer' | 'retire';
export interface NativeAskSlot {
 writing?: Promise<boolean>; frameKey?: string; closed: boolean;
 pending?: { cancel: () => void; timer?: ReturnType<typeof setTimeout> };
}
export interface NativeAskRetirement { timeoutMs: number; onTimeout: () => void }
/** Keep the native ask and its timer until a write receipt, transport loss, or retirement.
 * A retirement racing a write joins that write and commits its result exactly once. */
export function deliverNative(slot: NativeAskSlot, mode: AskMode, frameKey: string,
 write: () => Promise<boolean>, writable: () => boolean, commit: (accepted: boolean) => void, canWrite: () => boolean = () => true,
 retirement?: NativeAskRetirement,
 /** G0-NA: told of a refused write (the error the write threw) BEFORE commit(false); the returned teardown is awaited before `writing` resolves. */
 refused?: (error: unknown) => void | Promise<unknown>): Promise<boolean> {
 if (slot.closed) return Promise.resolve(false);
 const boundRetirement = () => {
  const pending = slot.pending;
  if (mode !== 'retire' || !retirement || !pending || pending.timer) return;
  pending.timer = setTimeout(() => {
   if (slot.closed) return;
   slot.closed = true;
   pending.cancel();
   try { commit(false); } finally { retirement.onTimeout(); }
  }, retirement.timeoutMs);
 };
 if (slot.writing) {
  const writing = slot.writing;
  if (mode === 'retire') {
   // Retirement never writes a competing frame. The outstanding callback
   // still owns acceptance; a failed callback closes with the retirement source.
   void writing.then(ok => { if (!slot.closed) { slot.closed = true; commit(ok); } });
   boundRetirement();
  }
  // A bounded retirement joins the existing receipt even for a competing
  // cancellation frame. It must not let the caller park an uncertain child.
  if (mode === 'retire' && retirement) return writing;
  return slot.frameKey === frameKey ? writing : Promise.resolve(false);
 }
 slot.frameKey = frameKey;
 // Install the promise before invoking a possibly reentrant write.
 let held=false;
 let cancel!: () => void;
 const cancelled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
 const pending = { cancel } as NonNullable<NativeAskSlot['pending']>;
 slot.pending = pending;
 let refusedBy: { error: unknown } | undefined;
 const receipt = Promise.resolve().then(()=>{if(!canWrite()){held=true;return false;}return write();}).catch(error => { refusedBy = { error }; return false; });
 const writing = (retirement ? Promise.race([receipt, cancelled]) : receipt).then(async ok => {
  let teardown: void | Promise<unknown> = undefined;
  if (refusedBy && refused) { try { teardown = refused(refusedBy.error); } catch { /* the refusal is already claimed */ } }
  if (!held && !slot.closed && (ok || mode === 'retire' || !writable() || refusedBy)) { slot.closed = true; commit(ok); }
  if (teardown) { try { await teardown; } catch { /* teardown never rejects the ask */ } }
  return ok;
 }).finally(() => {
  if (pending.timer) clearTimeout(pending.timer);
  if (slot.pending === pending) slot.pending = undefined;
  if (slot.writing === writing) { slot.writing = undefined; slot.frameKey = undefined; }
 });
 slot.writing = writing;
 boundRetirement();
 return writing;
}
