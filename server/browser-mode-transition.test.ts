import { expect, it, vi } from 'vitest';
import { BrowserModeTransition, type BrowserChoiceBot, type BrowserChoice, type DirectReservation } from './browser-mode-transition.ts';
import { BrowserLifecycleGate } from './browser-lifecycle-gate.ts';
import { SessionGate } from './browser-session-gate.ts';
const deferred = () => { let resolve!:()=>void; const promise = new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; };
function fixture(hooks: {beforeWrite?:()=>Promise<void>;validateCommit?:()=>void} = {}) {
  const bots = new Map<string,BrowserChoiceBot>([['a',{id:'a',name:'Ava',browserMode:'builtin',selectionRevision:0}],['b',{id:'b',name:'Kai',browserMode:'builtin',selectionRevision:0}]]);
  let reservation: DirectReservation | undefined;
  const lifecycle = new BrowserLifecycleGate(), sessions = new SessionGate(), held = new Set<string>();
  const release = vi.fn(async()=>{}), write = vi.fn((id:string, patch:Partial<BrowserChoiceBot>, next:DirectReservation|undefined)=>{Object.assign(bots.get(id)!,patch);reservation=next;});
  const transition = new BrowserModeTransition({ ...hooks, lifecycle, sessions, bot:id=>bots.get(id), bots:()=>[...bots.values()], reservation:()=>reservation, write,
    key:bot=>bot.browserMode === 'chrome-extension' ? null : bot.browserMode === 'chrome-direct' ? 'direct-'+bot.id : bot.browserProfile ?? bot.id,
    blocksCommit:key=>held.has(key)?'held':null, paused:()=>false, release, destinationContext:()=>({profiles:[{id:'work',name:'Work'}]}) });
  const choice = (id:string, mode:BrowserChoice['mode'], profile?:string):BrowserChoice => {
    const p=transition.preview(id,{mode,profile});return {mode,profile,baseRevision:bots.get(id)!.selectionRevision??0,disclosureKey:p.disclosure.disclosureKey};
  };
  return {bots,lifecycle,sessions,held,release,write,transition,choice,reservation:()=>reservation};
}
it('T1/EP23 admission during commit waits; pending applies before the next snapshot', async()=>{
  const f=fixture(), entered=deferred(), proceed=deferred();
  const blocker=f.sessions.run(['a'],async()=>{entered.resolve();await proceed.promise;});await entered.promise;
  const commit=f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));
  const snapshots:string[]=[];
  const turn=f.lifecycle.admitTurn('a','t',async()=>{snapshots.push(f.bots.get('a')!.browserMode!);});
  proceed.resolve();await Promise.all([blocker,commit,turn]);expect(snapshots).toEqual(['chrome-extension']);
  expect(await f.transition.applyBrowserChoice('a',f.choice('a','builtin'))).toMatchObject({queued:true});
  expect(f.bots.get('a')!.browserMode).toBe('chrome-extension');
  const ending=f.lifecycle.releaseTurn('t');
  const next=f.lifecycle.admitTurn('a','u',async()=>{snapshots.push(f.bots.get('a')!.browserMode!);});
  await Promise.all([ending,next]);expect(snapshots).toEqual(['chrome-extension','builtin']);
});
it('T2/EP22 release failure survives, blocks next commit and switch back, then recovers',async()=>{
  const f=fixture();f.release.mockRejectedValue(new Error('no ack'));
  await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));
  expect(f.bots.get('a')!.browserRelease?.mode).toBe('builtin');
  await expect(f.transition.applyBrowserChoice('a',f.choice('a','chrome-direct'))).rejects.toMatchObject({code:'release_pending'});
  await expect(f.transition.recover('a')).resolves.toBe(false);
  expect(f.bots.get('a')!.browserRelease?.mode).toBe('builtin');
  f.release.mockResolvedValue();await f.transition.recover('a');
  await f.transition.applyBrowserChoice('a',f.choice('a','chrome-direct'));expect(f.bots.get('a')!.browserMode).toBe('chrome-direct');
});
it('T3/M8/M9 two direct commits, delayed release and rejected hold leave one reservation (100 schedules)',async()=>{
  for(let i=0;i<100;i++){
    const f=fixture(), a=f.choice('a','chrome-direct'), b=f.choice('b','chrome-direct');
    const enteredCommit=deferred(),allowCommit=deferred();
    const blocker=f.sessions.run(['a','b'],async()=>{enteredCommit.resolve();await allowCommit.promise;});await enteredCommit.promise;
    const attempts=i%2?[f.transition.applyBrowserChoice('b',b),f.transition.applyBrowserChoice('a',a)]:[f.transition.applyBrowserChoice('a',a),f.transition.applyBrowserChoice('b',b)];
    allowCommit.resolve();await blocker;const result=await Promise.allSettled(attempts);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const winner=f.reservation()!.botId, loser=winner==='a'?'b':'a', wait=deferred(),entered=deferred();
    f.release.mockImplementation(async()=>{entered.resolve();await wait.promise;});
    const leaving=f.transition.applyBrowserChoice(winner,f.choice(winner,'builtin'));await entered.promise;
    expect(f.reservation()?.state).toBe('releasing');
    await expect(f.transition.applyBrowserChoice(loser,f.choice(loser,'chrome-direct'))).rejects.toMatchObject({code:'direct_reserved'});
    wait.resolve();await leaving;expect(f.reservation()).toBeUndefined();
  }
  const f=fixture();f.held.add('a');await expect(f.transition.applyBrowserChoice('a',f.choice('a','chrome-direct'))).rejects.toMatchObject({code:'held'});expect(f.reservation()).toBeUndefined();expect(f.write).not.toHaveBeenCalled();
});
it('T6/T6b/M37s restored source/destination holds block at the final gated check with no effects',async()=>{
  for(const key of ['a','work']){const f=fixture(), c=f.choice('a','builtin','work');f.held.add(key);await expect(f.transition.applyBrowserChoice('a',c)).rejects.toMatchObject({code:'held'});expect(f.release).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();}
  const f=fixture(),entered=deferred(),proceed=deferred();
  const take=f.sessions.run(['a'],async()=>{entered.resolve();await proceed.promise;f.held.add('a');});await entered.promise;
  const commit=f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));proceed.resolve();await take;
  await expect(commit).rejects.toMatchObject({code:'held'});expect(f.write).not.toHaveBeenCalled();
});
it('EP V revision and disclosure refusals write and release nothing',async()=>{
  const f=fixture(),c=f.choice('a','chrome-extension');
  await expect(f.transition.applyBrowserChoice('a',{...c,baseRevision:99})).rejects.toMatchObject({code:'revision_changed'});
  await expect(f.transition.applyBrowserChoice('a',{...c,disclosureKey:'stale'})).rejects.toMatchObject({code:'disclosure_stale'});
  expect(f.write).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
});
it('EP N1 lasting choice, exact undo and unchanged ask level',async()=>{
  const f=fixture(),bot=f.bots.get('a')!;Object.assign(bot,{browserMode:'chrome-extension',browserExtensionProfileId:'personal',browserExtensionBrowser:'edge',browserApproval:'step'});
  await f.transition.applyBrowserChoice('a',f.choice('a','builtin'));
  expect(bot.previousBrowserChoice).toMatchObject({mode:'chrome-extension',profile:'personal',browser:'edge'});
  for(let n=0;n<3;n++){await f.lifecycle.admitTurn('a','t'+n,async()=>expect(bot.browserMode).toBe('builtin'));await f.lifecycle.releaseTurn('t'+n);}
  const back=f.transition.preview('a',bot.previousBrowserChoice!);
  await f.transition.applyBrowserChoice('a',{...bot.previousBrowserChoice!,baseRevision:bot.selectionRevision!,disclosureKey:back.disclosure.disclosureKey});
  expect(bot).toMatchObject({browserMode:'chrome-extension',browserExtensionProfileId:'personal',browserExtensionBrowser:'edge',browserApproval:'step'});
  expect(bot.previousBrowserChoice).toBeUndefined();
});
it('EP pending replacement, cancel and stale queued revision',async()=>{
 const f=fixture();await f.lifecycle.admitTurn('a','t',async()=>{});
 await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));await f.transition.applyBrowserChoice('a',f.choice('a','builtin','guest'));
 expect(f.bots.get('a')!.pendingBrowserChoice?.profile).toBe('guest');await f.transition.cancel('a',0);expect(f.bots.get('a')!.pendingBrowserChoice).toBeUndefined();
 await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));f.bots.get('a')!.selectionRevision=2;await f.lifecycle.releaseTurn('t');expect(f.bots.get('a')!.browserMode).toBe('builtin');expect(f.bots.get('a')!.pendingBrowserChoice).toBeUndefined();
});
it('EP22 a release that never acknowledges times out without clearing the marker',async()=>{
 vi.useFakeTimers();try{
 const f=fixture();f.release.mockImplementation(()=>new Promise<void>(()=>{}));
 const apply=f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));await vi.advanceTimersByTimeAsync(10001);await apply;
 for(let i=0;i<2;i++){const retry=f.transition.recover('a');await vi.advanceTimersByTimeAsync(10001);expect(await retry).toBe(false);}
 expect(f.bots.get('a')!.browserRelease).toMatchObject({mode:'builtin',attempts:3});
 }finally{vi.useRealTimers();}
});
it('EP21 a crash immediately after the committed write leaves R recoverable',async()=>{
 const f=fixture(),write=f.write.getMockImplementation()!;
 f.write.mockImplementationOnce((...args)=>{write(...args);throw new Error('crash after C');});
 await expect(f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'))).rejects.toThrow('crash after C');
 expect(f.release).not.toHaveBeenCalled();expect(f.bots.get('a')!.browserRelease?.mode).toBe('builtin');
 await f.transition.recover('a');expect(f.release).toHaveBeenCalledTimes(1);expect(f.bots.get('a')!.browserRelease).toBeUndefined();
});
it('EP Switch now times out at 15 seconds with pending and the running route intact',async()=>{
 vi.useFakeTimers();try{const f=fixture();await f.lifecycle.admitTurn('a','t',async()=>{});
 await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));const interrupt=vi.fn(async()=>{});
 const switching=f.transition.switchNow('a',0,interrupt);await vi.advanceTimersByTimeAsync(15001);
 expect(await switching).toEqual({stopping:true});expect(interrupt).toHaveBeenCalledTimes(1);expect(f.bots.get('a')!.browserMode).toBe('builtin');expect(f.bots.get('a')!.pendingBrowserChoice).toBeDefined();expect(f.release).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});
it('EP setup callbacks cannot pin a profile after the owner changes selection',async()=>{
 const f=fixture();await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));const revision=f.bots.get('a')!.selectionRevision!;
 await f.transition.applyBrowserChoice('a',f.choice('a','builtin'));f.write.mockClear();
 expect(await f.transition.completeSetup('a',revision,'personal','chrome')).toBe(false);expect(f.bots.get('a')!.browserMode).toBe('builtin');expect(f.write).not.toHaveBeenCalled();
});
it('EP Switch now cannot commit after capability revocation until the provider acknowledges idle',async()=>{
 const f=fixture(),bot=f.bots.get('a')!;bot.busy=true;await f.lifecycle.admitTurn('a','t',async()=>{});
 await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));await f.lifecycle.releaseTurn('t');
 expect(bot.browserMode).toBe('builtin');expect(f.release).not.toHaveBeenCalled();bot.busy=false;await f.transition.applyPending('a');expect(bot.browserMode).toBe('chrome-extension');
});
it('EP setup pins only the current unpaired revision, and keeps a running turn unchanged',async()=>{
 const f=fixture();await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'));const b=f.bots.get('a')!,revision=b.selectionRevision!;
 await f.lifecycle.admitTurn('a','t',async()=>{});expect(await f.transition.completeSetup('a',revision,'personal','chrome')).toBe(false);expect(b.browserExtensionProfileId).toBeUndefined();await f.lifecycle.releaseTurn('t');
 expect(await f.transition.completeSetup('a',revision,'personal','chrome')).toBe(true);expect(b.browserExtensionProfileId).toBe('personal');expect(b.selectionRevision).toBe(revision);
});
it('EP invalid browser and profile choices have no write or release effects',async()=>{
 const f=fixture();for(const choice of [{...f.choice('a','chrome-extension'),browser:'firefox'},{...f.choice('a','chrome-extension'),profile:'not/a/profile'}])await expect(f.transition.applyBrowserChoice('a',choice as BrowserChoice)).rejects.toMatchObject({code:'invalid_choice'});expect(f.write).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
});

it('waits out a writer hold and revalidates the revision before committing',async()=>{
 const resume=deferred(),beforeWrite=vi.fn(()=>resume.promise);
 const f=fixture({beforeWrite});
 const result=f.transition.applyBrowserChoice('a',f.choice('a','chrome-direct')).then(value=>value,error=>error);
 try {
   await expect.poll(()=>beforeWrite.mock.calls.length,{timeout:1000}).toBe(1);
   expect(f.write).not.toHaveBeenCalled();
   f.bots.get('a')!.selectionRevision=1;resume.resolve();
   expect(await result).toMatchObject({code:'revision_changed'});
   expect(f.write).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
 } finally {resume.resolve();await result;}
});
it('refuses a profile claim when configuration validation starts before the final write',async()=>{
 let blocked=false;const entered=deferred(),resume=deferred();
 const f=fixture({validateCommit:()=>{if(blocked)throw Object.assign(new Error('config busy'),{status:409});}});
 const blocker=f.sessions.run(['a','work'],async()=>{entered.resolve();await resume.promise;});await entered.promise;
 const applying=f.transition.applyBrowserChoice('a',f.choice('a','builtin','work'));
 const checked=expect(applying).rejects.toMatchObject({status:409});
 blocked=true;resume.resolve();await blocker;await checked;expect(f.write).not.toHaveBeenCalled();
});
