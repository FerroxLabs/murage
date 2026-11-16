// SPDX-License-Identifier: AGPL-3.0-or-later
// Ledger writer owner: scperf-p1 (io-budget). Checkpoint reader/writer owner: scperf-p1 (WM).
/** Self-contained so the eval WM uses exactly this implementation after bundling. */
export function checkpointLedger(buffer:SharedArrayBuffer) {
 const slots=new BigInt64Array(buffer);
 const lock=()=>{while(Atomics.compareExchange(slots,0,0n,1n)!==0n){/* integer-only short critical sections */}};
 const unlock=()=>{Atomics.store(slots,0,0n);};
 const rotate=(now:number)=>{
  const minute=BigInt(Math.floor(now/60_000));
  if(Atomics.load(slots,1)!==minute){
   Atomics.store(slots,1,minute);
   for(const n of [2,3,5,6,8,11])Atomics.store(slots,n,0n);
   Atomics.store(slots,9,Atomics.load(slots,12));Atomics.store(slots,10,Atomics.load(slots,13));
   // No foreground activity has yet been proved in the new minute.
   Atomics.store(slots,7,1n);
  }
 };
 const beginCopy=(ceiling:number,now:number)=>{
  lock();
  try{
   rotate(now);
   const total=Number(Atomics.load(slots,3)),reserved=Number(Atomics.load(slots,6));
   const idle=Atomics.load(slots,7)!==0n;
   if(idle&&(now%60_000>55_000||total+reserved+ceiling>1024*1024-65536))return null;
   Atomics.add(slots,6,BigInt(ceiling));
   return {minute:Number(Atomics.load(slots,1)),ceiling,observed:Number(Atomics.load(slots,11))};
  }finally{unlock();}
 };
 const endCopy=(ticket:{minute:number;ceiling:number;observed?:number},used:number,raw=0,reading?:{os:number;meter:number})=>{
  lock();
  try{
   if(Number(Atomics.load(slots,1))===ticket.minute){
    Atomics.sub(slots,6,BigInt(ticket.ceiling));
    if(reading){
      const observed=Math.max(0,reading.os-Number(slots[9]),reading.meter-Number(slots[10]));
      Atomics.store(slots,11,BigInt(Math.max(Number(slots[11]),observed)));
      Atomics.store(slots,12,BigInt(reading.os));Atomics.store(slots,13,BigInt(reading.meter));
    }
    const included=Math.min(raw,Math.max(0,Number(slots[11])-(ticket.observed??0)));
    Atomics.add(slots,8,BigInt(used-included));Atomics.store(slots,3,slots[11]+slots[8]);
   }
  }finally{unlock();}
 };
 return {slots,lock,unlock,rotate,beginCopy,endCopy};
}
