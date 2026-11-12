// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import { flushCoalesced } from '../../atomic.ts';
import { database } from '../../database.ts';
import { signalHumanBindings, revokeHumanConnection } from '../../human-principals.ts';
import { ownerMemoryTicket } from '../../memory/authority.ts';
import { isOpenRoutineRunStatus, type RoutineManager } from '../../routines.ts';
import { revokeSignalLocalAuthority } from './service.ts';
import { ParkFs } from './park-fs.ts';
import type { SignalLocalAuthority } from './park-replacement.ts';

/** Authoritative stores, shared by startup replay and the owner action. */
export function createSignalLocalAuthority(root: string, routines: RoutineManager, fence: () => void): SignalLocalAuthority {
  return {
    fence,
    inventory: () => {
      const runs=routines.listRuns().filter(run=>run.channelOrigin?.platform==="signal"&&isOpenRoutineRunStatus(run.status));
      return {connectionIds:[...new Set([...signalHumanBindings(ownerMemoryTicket()).map(row=>row.origin.connectionId),...runs.map(run=>run.channelOrigin!.connectionId)])],runIds:runs.map(run=>run.id)};
    },
    revoke: async (ids,runIds) => {
      for(const id of ids)await revokeSignalLocalAuthority({people:{revoke:async connectionId=>{revokeHumanConnection("signal",connectionId);}},revokeRuns:async connectionId=>{
        for(const run of routines.listRuns().filter(row=>row.channelOrigin?.platform==="signal"&&row.channelOrigin.connectionId===connectionId)){
          routines.closeEventBudget(run.id);if(isOpenRoutineRunStatus(run.status))await routines.cancelRun(run.id);
        }
      }},id);
      for(const run of routines.listRuns().filter(run=>runIds.includes(run.id)||(run.channelOrigin?.platform==="signal"&&ids.includes(run.channelOrigin.connectionId)))){
        routines.closeEventBudget(run.id);if(isOpenRoutineRunStatus(run.status))await routines.cancelRun(run.id);
      }
    },
    verify: (ids,runIds) => !signalHumanBindings(ownerMemoryTicket()).some(row=>row.active&&ids.includes(row.origin.connectionId))
      && !routines.listRuns().some(run=>isOpenRoutineRunStatus(run.status)&&(runIds.includes(run.id)||(run.channelOrigin?.platform==="signal"&&ids.includes(run.channelOrigin.connectionId)))),
    flush: async () => {
      flushCoalesced();
      const result=database().prepare("PRAGMA wal_checkpoint(FULL)").get() as {busy?:number;log?:number;checkpointed?:number}|undefined;
      if(!result||result.busy!==0||result.log!==result.checkpointed)throw new Error("Signal authority save is held");
      const io=new ParkFs(root);
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
