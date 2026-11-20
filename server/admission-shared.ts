// SPDX-License-Identifier: AGPL-3.0-or-later
// Ledger writer owner: scperf-p1 (io-budget). Checkpoint reader/writer owner: scperf-p1 (WM).
/** Self-contained so the eval WM uses exactly this implementation after bundling.
 * `owner` is the thread id of the caller (0 on the main thread). The lock word holds a token that is unique to each
 * acquisition: owner id in the high 32 bits, a per-thread sequence in the low 32 bits.
 *
 * worker.terminate() runs no finally block, so a thread ended inside a critical section leaves its token behind. The rules:
 *  1. A lock is NEVER taken over by time. A holder that is slow, descheduled or paused might be alive, and a live holder that
 *     lost its lock would keep writing without owning it. Only the main thread, after it has CONFIRMED the holder's exit (the
 *     worker's 'exit' event), may clear the word, and only if it still holds that thread's token: recoverAfterExit(id).
 *  2. The MAIN THREAD (owner 0) never waits or spins: lock() is ONE non-blocking compare-exchange and, when the word is busy,
 *     throws an error named AdmissionLockTimeout at once (Atomics.wait is not allowed on the main thread and a busy loop would
 *     stop the event loop). A worker thread may wait in Atomics.wait slices under ONE total deadline (deadlineMs, measured once
 *     at entry, independent of token changes or owner progress) and then throws the same error. Every caller fails closed
 *     (see io-budget.ts for the main thread and wal-maintenance.ts for the worker) and retries on its normal next tick.
 *  3. Recovery is conservative: the ledger is marked POISONED (slot 15) instead of trusting counters the dead thread may have
 *     left half updated. While poisoned no copy is admitted; rebuild recomputes the shared counters from the owner's real state.
 *  4. (D6) A worker's in-flight reservation is an OWNED entry in a table of TABLE_N entries (slots 18..29, three slots each:
 *     owner, bytes, minute), never one ownerless counter. owner = (threadId << 32) | gen (0 = empty; the main thread is never an
 *     owner). The main thread reconciles an entry only after the owner's CONFIRMED exit (reconcileEntry, under its own one CAS):
 *     a covered release (a valid continuous post-exit measurement shows the bytes) or a charge to the current minute.
 *     Reservations are live work, not per-minute: rotate() no longer zeroes slots 5/6.
 * Slots: 0 lock, 1 minute, 2 bg used, 3 total, 4 debt, 5 bg reserved, 6 writes reserved, 7 idle, 8 settled charge, 9/10 base,
 * 11 observed, 12/13 last reading, 14 recoveries, 15 poison, 16 table-full count, 17 reconcile count (16 and 17 are diagnostic,
 * never in a sum), 18..29 owner table, 30 recall-reclaim bucket bytes this minute, 31 reclaim copy request (minute + 1, 0 = none).
 * A torn minute rotation is redone (the minute is written last).
 *  5. (Fable BLOCK bb30fb1d03, owner: the recallcap racer) The strict idle rule (about 1 MB a minute while idle) refuses every log copy
 *     while other writes run, so a log the recall reclaimer filled to its gate only reset around owner turns. A copy the reclaimer asked
 *     for in THIS minute (slot 31, set by IoBudget.requestReclaimCopy when it is held at the log gate) that the idle rule refuses is
 *     admitted under the reclaimer's own 700 MB/min bucket (slot 30: its slices' charges plus such copies), never past it; one copy per
 *     request. Poison, the table and every other copy keep their rules. */
export function isAdmissionLockTimeout(error:unknown):boolean {return error instanceof Error&&error.name==="AdmissionLockTimeout";}
export function checkpointLedger(buffer:SharedArrayBuffer,owner=0,deadlineMs=2000,opts?:{gen?:number}) {
 const slots=new BigInt64Array(buffer);
 const LOCK_SPINS=2048,mainThread=owner===0,TABLE_N=4,TABLE_AT=18;
 // Self-contained (the worker evaluates this function's source): equal to io-budget RECALL_RECLAIM_BYTES_PER_MINUTE, pinned by a test.
 const RECLAIM_BUCKET=700_000_000n;
 const me=(BigInt(owner)<<32n)|BigInt((opts?.gen??0)>>>0);
 let seq=0n,held=0n;
 const lock=()=>{
  seq=seq>=0xffffffffn?1n:seq+1n;
  const mine=(BigInt(owner)<<32n)|seq;
  const t0=performance.now();
  let spins=0;
  for(;;){
   if(Atomics.compareExchange(slots,0,0n,mine)===0n){held=mine;return;}
   if(mainThread){
    const error=new Error("ADMISSION_LOCK_TIMEOUT: the ledger lock is held (the main thread never waits for it)");
    error.name="AdmissionLockTimeout";
    throw error;
   }
   if(++spins<LOCK_SPINS)continue;
   const left=deadlineMs-(performance.now()-t0);
   if(left<=0){
    const error=new Error(`ADMISSION_LOCK_TIMEOUT: the ledger lock stayed held for ${deadlineMs} ms`);
    error.name="AdmissionLockTimeout";
    throw error;
   }
   const cur=Atomics.load(slots,0);
   if(cur===0n)continue;
   try{Atomics.wait(slots,0,cur,Math.min(1,left));}catch{const end=performance.now()+1;while(performance.now()<end){/* Atomics.wait is not allowed on this thread: a 1 ms pause on the clock */}}
  }
 };
 const unlock=()=>{if(Atomics.compareExchange(slots,0,held,0n)===held)Atomics.notify(slots,0);held=0n;};
 const poisoned=()=>Atomics.load(slots,15)!==0n;
 /** Main thread only, after the worker's 'exit' event (or terminate() resolving), never on a timer. Returns true when the lock word
  * still held that thread's token: the ledger is poisoned and the lock is released. Nobody else can be inside the section while the
  * dead token holds the word, so no lock is needed. The thread's reservation (its table entry) is reconciled separately. */
 const recoverAfterExit=(id:number)=>{
  const cur=Atomics.load(slots,0);
  if(cur===0n||(cur>>32n)!==BigInt(id))return false;
  Atomics.store(slots,15,1n);
  Atomics.add(slots,14,1n);
  if(Atomics.compareExchange(slots,0,cur,0n)!==cur)return false;
  Atomics.notify(slots,0);
  return true;
 };
 /** The ledger could not be proven clean (a worker did not exit in time): fail closed until rebuild. Never touches the lock. */
 const poison=()=>{Atomics.store(slots,15,1n);};
 /** Release or charge the table entry i (the lock is held by the caller). covered: the bytes are proven inside the observed counters, so
  * release only; otherwise they are charged to the current minute. skipSix: the caller recomputes slot 6 (poisoned ledger). */
 const reconcileEntry=(i:number,covered:boolean,skipSix:boolean)=>{
  const b=TABLE_AT+i*3;
  if(Atomics.load(slots,b)===0n)return 0n;
  const bytes=Atomics.load(slots,b+1);
  if(!skipSix){const cur=Atomics.load(slots,6);Atomics.sub(slots,6,bytes>cur?cur:bytes);}
  if(!covered){Atomics.add(slots,8,bytes);Atomics.store(slots,3,Atomics.load(slots,11)+Atomics.load(slots,8));}
  Atomics.store(slots,b+1,0n);
  Atomics.store(slots,b,0n);
  Atomics.add(slots,17,1n);
  return bytes;
 };
 /** The table entries that are held (lock held by the caller): [index, owner word, bytes, minute]. At most TABLE_N. */
 const entries=()=>{
  const out:[number,bigint,bigint,bigint][]=[];
  for(let i=0;i<TABLE_N;i++){const b=TABLE_AT+i*3,o=Atomics.load(slots,b);if(o!==0n)out.push([i,o,Atomics.load(slots,b+1),Atomics.load(slots,b+2)]);}
  return out;
 };
 /** Reconcile every held entry whose owner is not live (lock held). coveredFor decides per entry. Returns how many. */
 const reconcileDead=(isLive:(o:bigint)=>boolean,coveredFor:(o:bigint,minute:number,bytes:number)=>boolean,skipSix:boolean)=>{
  let n=0;
  for(const [i,o,bytes,minute] of entries()){if(isLive(o))continue;reconcileEntry(i,coveredFor(o,Number(minute),Number(bytes)),skipSix);n++;}
  return n;
 };
 /** Lock held. Recompute slots 3..6 from the owner's real state plus the live owners' entries, reconcile the dead ones, clear the poison last. */
 const rebuildLocked=(owned:{writes:number;bgReserved:number;debt:number},isLive:(o:bigint)=>boolean=()=>false,coveredFor:(o:bigint,minute:number,bytes:number)=>boolean=()=>false)=>{
  let live=0n;
  for(const [i,o,bytes,minute] of entries()){
   if(isLive(o))live+=bytes;else reconcileEntry(i,coveredFor(o,Number(minute),Number(bytes)),true);
  }
  Atomics.store(slots,6,BigInt(owned.writes)+live);
  Atomics.store(slots,5,BigInt(owned.bgReserved));
  Atomics.store(slots,4,BigInt(owned.debt));
  Atomics.store(slots,3,Atomics.load(slots,11)+Atomics.load(slots,8));
  Atomics.store(slots,15,0n);
 };
 /** Main thread, standalone (tests and the ledger-only path): one lock, rebuild when poisoned. */
 const rebuild=(owned:{writes:number;bgReserved:number;debt:number},isLive?:(o:bigint)=>boolean,coveredFor?:(o:bigint,minute:number,bytes:number)=>boolean)=>{
  lock();
  try{
   if(!poisoned())return false;
   rebuildLocked(owned,isLive,coveredFor);
   return true;
  }finally{unlock();}
 };
 const recoveries=()=>Number(Atomics.load(slots,14));
 const tableFullCount=()=>Number(Atomics.load(slots,16));
 const rotate=(now:number)=>{
  const minute=BigInt(Math.floor(now/60_000));
  if(Atomics.load(slots,1)!==minute){
   // 5/6 (reservations) are live work and stay: they are released by their own settlement or reconcile.
   for(const n of [2,3,8,11,30])Atomics.store(slots,n,0n);
   Atomics.store(slots,9,Atomics.load(slots,12));Atomics.store(slots,10,Atomics.load(slots,13));
   // Slot 7 (idle) is the owner's verdict, republished at every owner reading. A rotation seen first by the checkpointer thread must
   // NOT overwrite it with "idle".
   // Last: a rotation that was cut short keeps the old minute, so the next caller redoes all of it.
   Atomics.store(slots,1,minute);
  }
 };
 const beginCopy=(ceiling:number,now:number)=>{
  lock();
  try{
   if(poisoned())return null;
   rotate(now);
   const total=Number(Atomics.load(slots,3)),reserved=Number(Atomics.load(slots,6));
   const idle=Atomics.load(slots,7)!==0n;
   const minute=Atomics.load(slots,1);
   const c=BigInt(ceiling);
   let reclaim=false;
   if(idle&&(now%60_000>55_000||total+reserved+ceiling>1024*1024-65536)){
    // Rule 5: only a copy the reclaimer asked for this minute, and only inside what is left of its bucket.
    if(Atomics.load(slots,31)!==minute+1n||Atomics.load(slots,30)+c>RECLAIM_BUCKET)return null;
    reclaim=true;
   }
   let own=-1,empty=-1;
   for(let i=0;i<TABLE_N;i++){const o=Atomics.load(slots,TABLE_AT+i*3);if(me!==0n&&o===me){own=i;break;}if(o===0n&&empty<0)empty=i;}
   if(own<0&&empty<0){Atomics.add(slots,16,1n);return null;}
   if(reclaim){Atomics.add(slots,30,c);Atomics.store(slots,31,0n);}
   if(own>=0){
    const b=TABLE_AT+own*3;
    Atomics.store(slots,b+2,minute); // conservative: the entry is as young as its newest bytes
    Atomics.add(slots,b+1,c);Atomics.add(slots,6,c);
    return {minute:Number(minute),ceiling,observed:Number(Atomics.load(slots,11)),slot:own,reclaim};
   }
   const b=TABLE_AT+empty*3;
   Atomics.store(slots,b+1,0n);Atomics.store(slots,b+2,minute); // c1: owner 0 means the entry is ignored
   Atomics.store(slots,b,me);                                   // c2
   Atomics.add(slots,b+1,c);                                    // c3
   Atomics.add(slots,6,c);                                      // c4
   return {minute:Number(minute),ceiling,observed:Number(Atomics.load(slots,11)),slot:empty,reclaim};
  }finally{unlock();}
 };
 /** Main thread (the recall reclaimer, held at the log gate): asks for one log copy under its bucket in this minute (rule 5). One word, no lock. */
 const requestReclaimCopy=(now:number)=>{Atomics.store(slots,31,BigInt(Math.floor(now/60_000))+1n);};
 /** Main thread: a reclaim slice's charge to the shared bucket. Charged only into the ledger's current minute (a rotation zeroes slot 30). */
 const chargeReclaim=(bytes:number,now:number)=>{
  if(!(bytes>0)||Atomics.load(slots,1)!==BigInt(Math.floor(now/60_000)))return;
  Atomics.add(slots,30,BigInt(Math.ceil(bytes)));
 };
 const endCopy=(ticket:{minute:number;ceiling:number;observed?:number;slot?:number;reclaim?:boolean},used:number,raw=0,reading?:{os:number;meter:number},now?:number)=>{
  lock();
  try{
   // The worker always passes its clock. Without one the ledger's current minute is kept (no rotation): the charge lands where it is.
   rotate(now??Number(Atomics.load(slots,1))*60_000);
   const b=TABLE_AT+(ticket.slot??0)*3,c=BigInt(ticket.ceiling);
   // Rule 5: a reclaim copy's bucket charge is its ceiling until it ends; in the same minute it keeps only what it used.
   if(ticket.reclaim&&ticket.minute===Number(Atomics.load(slots,1))){const back=c-BigInt(Math.max(0,Math.min(ticket.ceiling,Math.ceil(used))));const cur=Atomics.load(slots,30);Atomics.sub(slots,30,back>cur?cur:back);}
   const mineEntry=Atomics.load(slots,b)===me;
   if(mineEntry){const cur=Atomics.load(slots,6);Atomics.sub(slots,6,c>cur?cur:c);} // r1
   if(reading){
    const observed=Math.max(0,reading.os-Number(slots[9]),reading.meter-Number(slots[10]));
    Atomics.store(slots,11,BigInt(Math.max(Number(slots[11]),observed)));
    Atomics.store(slots,12,BigInt(reading.os));Atomics.store(slots,13,BigInt(reading.meter));
   }
   const base=ticket.minute===Number(Atomics.load(slots,1))?(ticket.observed??0):0;
   const included=Math.min(raw,Math.max(0,Number(slots[11])-base));
   Atomics.add(slots,8,BigInt(Math.max(0,used-included)));Atomics.store(slots,3,slots[11]+slots[8]); // r2
   if(mineEntry){
    const cur=Atomics.load(slots,b+1);Atomics.sub(slots,b+1,c>cur?cur:c); // r3
    if(Atomics.load(slots,b+1)===0n)Atomics.store(slots,b,0n);           // r4
   }
  }finally{unlock();}
 };
 return {slots,lock,unlock,rotate,beginCopy,endCopy,requestReclaimCopy,chargeReclaim,recoverAfterExit,poison,poisoned,rebuild,rebuildLocked,recoveries,reconcileEntry,reconcileDead,entries,tableFullCount,ownerWord:me};
}
