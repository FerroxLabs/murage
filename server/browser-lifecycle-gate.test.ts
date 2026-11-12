import { expect, it } from 'vitest';
import { BrowserLifecycleGate } from './browser-lifecycle-gate.ts';
it('T1/M10 N4 admission leases apply pending work before the next admission', async () => {
  const gate = new BrowserLifecycleGate(); let revision = 0; let pending = false; const snapshots: number[] = [];
  gate.onIdle(async () => { if (pending) { revision++; pending = false; } });
  await gate.admitTurn('a', 'one', async () => { snapshots.push(revision); });
  await gate.run('a', async () => { expect(gate.hasLease('a')).toBe(true); pending = true; });
  const released = gate.releaseTurn('one');
  const next = gate.admitTurn('a', 'two', async () => { snapshots.push(revision); });
  await Promise.all([released, next]); expect(snapshots).toEqual([0, 1]);
  await gate.releaseTurn('two'); expect(gate.size).toBe(0);
});
it('a failed admission does not leave a lease', async () => {
  const gate = new BrowserLifecycleGate();
  await expect(gate.admitTurn('a', 'one', async () => { throw new Error('refused'); })).rejects.toThrow('refused');
  expect(gate.hasLease('a')).toBe(false); expect(gate.size).toBe(0);
});
it('T16 admission recovery precedes lease creation and release enqueues synchronously', async()=>{
  const gate=new BrowserLifecycleGate(),events:string[]=[];
  gate.onAdmission(async id=>{expect(gate.hasLease(id)).toBe(false);events.push('recover');});
  gate.onIdle(async()=>{events.push('pending');});
  await gate.admitTurn('a','t',async()=>{events.push('snapshot');});
  const ending=gate.releaseTurn('t');expect(gate.hasLease('a')).toBe(false);
  const next=gate.admitTurn('a','u',async()=>{events.push('next');});await Promise.all([ending,next]);
  expect(events).toEqual(['recover','snapshot','pending','recover','next']);
});
it('a thread cannot be admitted by two bots while release recovery is waiting',async()=>{
 const gate=new BrowserLifecycleGate();let unblock!:()=>void;let entered!:()=>void;
 const waiting=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{unblock=r;});
 gate.onAdmission(async()=>{entered();await hold;});
 const first=gate.admitTurn('a','shared-thread',async()=>{});await waiting;
 const second=gate.admitTurn('b','shared-thread',async()=>{});unblock();
 const result=await Promise.allSettled([first,second]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});
it('Stop during admission recovery prevents a late lease and binding',async()=>{
 const gate=new BrowserLifecycleGate();let unblock!:()=>void;let entered!:()=>void;
 const waiting=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{unblock=r;});
 gate.onAdmission(async()=>{entered();await hold;});let bound=false;
 const admission=gate.admitTurn('a','t',async()=>{bound=true;});const rejected=expect(admission).rejects.toThrow('browser_turn_cancelled');await waiting;
 const stopped=gate.releaseTurn('t');unblock();await rejected;await stopped;expect(bound).toBe(false);expect(gate.hasLease('a')).toBe(false);
});
