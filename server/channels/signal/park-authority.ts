// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import { flushCoalesced } from '../../atomic.ts';
import { database } from '../../database.ts';
import { signalHumanBindings, revokeHumanConnection } from '../../human-principals.ts';
import { ownerMemoryTicket } from '../../memory/authority.ts';
import { isOpenRoutineRunStatus, type RoutineManager } from '../../routines.ts';
import { ParkFs } from './park-fs.ts';
import type { SignalLocalAuthority } from './park-replacement.ts';

/** Authoritative stores, shared by startup replay and the owner action.
 * The factory lets isolated fixtures observe native admission without replacing
 * module bindings; callers otherwise use the ordinary ParkFs constructor. */
export function createSignalLocalAuthority(root: string, routines: RoutineManager, fence: () => void, createFs: (root:string) => ParkFs = root => new ParkFs(root)): SignalLocalAuthority {
  return {
    fence,
    inventory: () => {
      const runs=routines.listRuns().filter(run=>run.channelOrigin?.platform==="signal"&&isOpenRoutineRunStatus(run.status));
      return {connectionIds:[...new Set([...signalHumanBindings(ownerMemoryTicket()).map(row=>row.origin.connectionId),...runs.map(run=>run.channelOrigin!.connectionId)])],runIds:runs.map(run=>run.id)};
    },
    revoke: async (ids,runIds) => {
      const selected=routines.listRuns().filter(run=>runIds.includes(run.id)||(run.channelOrigin?.platform==="signal"&&ids.includes(run.channelOrigin.connectionId)));
      // Commit every cancellation before awaiting an interrupt or touching the
      // people store. An interrupted save cannot leave other old work queued.
      // cancelRun closes its event budget in the cancellation's durable mutation.
      const cancellations=await Promise.allSettled(selected.map(async run=>{
        if(isOpenRoutineRunStatus(run.status))await routines.cancelRun(run.id);
        else routines.closeEventBudget(run.id);
      }));
      const people=await Promise.allSettled(ids.map(async id=>{revokeHumanConnection("signal",id);}));
      const failed=[...cancellations,...people].find(result=>result.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
    },
    verify: (ids,runIds) => !signalHumanBindings(ownerMemoryTicket()).some(row=>row.active&&ids.includes(row.origin.connectionId))
      && !routines.listRuns().some(run=>(isOpenRoutineRunStatus(run.status)||(run.eventBudget&&!run.eventBudget.closed))&&(runIds.includes(run.id)||(run.channelOrigin?.platform==="signal"&&ids.includes(run.channelOrigin.connectionId)))),
    flush: async () => {
      flushCoalesced();
      // The background checkpointer can own SQLite's checkpoint lock. SQLite
      // returns BUSY immediately for that lock, even with a busy_timeout.
      // Yield briefly and retry, retaining the fence until the full checkpoint
      // succeeds. A persistent hold still refuses before a fresh identity.
      const deadline=performance.now()+5_000;
      for(;;) {
        const result=database().prepare("PRAGMA wal_checkpoint(FULL)").get() as {busy?:number;log?:number;checkpointed?:number}|undefined;
        if(result?.busy===0&&result.log===result.checkpointed)break;
        if(!result||result.busy!==1||performance.now()>=deadline)throw new Error("Signal authority save is held");
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      const io=createFs(root);
      for(const name of ["messages.db","routines.json"]){if(io.checked(join(root,name)))io.flushFile(join(root,name));}
      for(const name of ["events/routine-runs","events"]){if(io.checked(join(root,name)))io.barrier(join(root,name),true);}
      io.barrier(root,true);
    },
  };
}

/** An advisory cannot hide unfinished local authority from an earlier ID. */
export function hasEarlierSignalAuthority(routines: RoutineManager, currentId?: string): boolean {
  return signalHumanBindings(ownerMemoryTicket()).some(row=>row.active&&row.origin.connectionId!==currentId)
    || routines.listRuns().some(run=>run.channelOrigin?.platform==='signal'&&run.channelOrigin.connectionId!==currentId&&isOpenRoutineRunStatus(run.status));
}
