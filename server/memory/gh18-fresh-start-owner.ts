// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { awaitWriterGate, writersHeldForIndexBuild } from '../db-busy.ts';
import { beginRead, beginWrite, endWrite, undoWrite } from '../write-tx.ts';
import { ensureGH18Operations } from './schema.ts';
import { createKeepAllRepairGate, keepAllRepairBarrier, raceCeiling, type CursorClear, type KeepAllRepairGate, type RepairBot } from './keepall-unwedge.ts';

const POLICY = 'gh18-fresh-start-v2';
const TTL = 120_000;
const WRITER_WAIT_MS = 2_000;
import { freshStartPreviewRequestSchema as previewRequest, freshStartConfirmRequestSchema as confirmRequest,
  freshStartOutcomeSchema as outcomeSchema, type FreshStartOutcome as Outcome } from '../../shared/gh18-fresh-start-contract.ts';
import { planFreshStart, applyFreshStartRows, type FreshStartPlan, type FreshStartPolicy } from './gh18-fresh-start.ts';
export type { FreshStartPlan, FreshStartPolicy } from './gh18-fresh-start.ts';
/** A static import keeps the shipped bundle on the same reviewed P1 policy. */
export async function loadFreshStartPolicy(): Promise<FreshStartPolicy> { return { planFreshStart, applyFreshStartRows }; }
const cursorAuditSchema = z.array(z.strictObject({botId:z.string().min(1),threadId:z.string().min(1),instanceId:z.string().min(1),cursorJson:z.string(),incarnation:z.number().int().optional()})).min(1).max(5000);
interface Owner { owner:string; session:string }
interface Operation { operation_id:string; request_digest:string; outcome_json:string; cursor_clears_json:string; cursors_applied:number; policy_version:string; installation:string; owner:string; bot_id:string }
interface Token {owner:string;session:string;installation:string;botId:string;snapshot:string;expiresAt:number}
export interface FreshStartOwnerDeps {
  db():DatabaseSync;
  bot(id:string):(RepairBot & {name:string}) | undefined;
  policy?:FreshStartPolicy;
  /** Required release gate: older validators must accept the additive audit schema. */
  schemaCompatible():boolean;
  storeRevision():number;
  /** Bot-wide activity includes room admissions whose thread is not a task. */
  botBusy(id:string):boolean;
  liveThreads():ReadonlySet<string>;
  ownerDirectThread(id:string):boolean;
  pendingDeletion(threadId:string):boolean;
  clearCursors(clears:CursorClear[]):void;
  flush():void;
  now?():number;
  writerGate?():Promise<void>;
}
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (status:number,error:string) => Object.assign(new Error(error),{status});
const hasAudit = (db:DatabaseSync) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='gh18_operations' AND type='table'").get());
const installation = (db:DatabaseSync) => {
  const id=db.prepare('SELECT installation_id FROM memory_meta WHERE id=1').get()?.installation_id;
  if (typeof id !== 'string' || !id) throw failure(503,'unsupported-schema'); return id;
};

/** Auth is a live boundary callback, rechecked after writer waits and inside the transaction.
 * No approval-mode input exists: No limits cannot authorize this action. */
export function createFreshStartOwner(deps:FreshStartOwnerDeps) {
  const tokens = new Map<string,Token>();
  const gates = new Map<string,KeepAllRepairGate>();
  const now = deps.now ?? Date.now;
  const auth = (read:()=>Owner|null) => { const owner=read(); if (!owner?.owner || !owner.session) throw failure(403,'owner-required'); return owner; };
  const bot = (id:string) => { const value=deps.bot(id); if (!value) throw failure(404,'no-such-bot'); return value; };
  const snapshot = (db:DatabaseSync, b:RepairBot & {name:string}) => digest({
    bot:{id:b.id,name:b.name,tasks:b.tasks?.map(t=>({threadId:t.threadId,cursors:t.resumeCursors,incarnations:t.resumeIncarnations,audiences:t.resumeAudiences}))},
    storeRevision:deps.storeRevision(),
    meta:db.prepare('SELECT * FROM memory_meta WHERE id=1').get(),
    // Includes changes outside memory_meta (holds, lineage, roster revokes) from this handle AND other connections.
    local:db.prepare('SELECT total_changes() AS n').get(), external:db.prepare('PRAGMA data_version').get(), schema:db.prepare('PRAGMA schema_version').get(),
  });
  const classify = (db:DatabaseSync,b:RepairBot):FreshStartPlan => {
    const empty:FreshStartPlan={botId:b.id,sessionRows:[],cursorClears:[],retainedBlocks:0,retainedCapped:false,blocked:null};
    if (!deps.schemaCompatible()) return {...empty,blocked:'unsupported-schema'};
    if (!deps.policy) return {...empty,blocked:'policy-unavailable'};
    const start=performance.now();
    if (deps.botBusy(b.id)) return {...empty,blocked:'bot-busy'};
    // One activity snapshot per synchronous classification, inside its budget.
    const liveThreads=deps.liveThreads();
    const plan=deps.policy.planFreshStart(db,b,{ownerDirectThread:deps.ownerDirectThread,liveThreads,pendingDeletion:deps.pendingDeletion});
    if (plan.botId!==b.id || plan.cursorClears.some(c=>c.botId!==b.id)) throw failure(503,'policy-unavailable');
    const taskBusy=(b.tasks??[]).some(t=>t.busy || liveThreads.has(t.threadId));
    if (performance.now()-start>100 || plan.sessionRows.length>5000 || plan.cursorClears.length>5000) return {...empty,blocked:'limit-exceeded'};
    if (taskBusy) return {...plan,blocked:'bot-busy',sessionRows:[],cursorClears:[]};
    return plan;
  };
  const stored = (row:Operation):Outcome => {
    if (row.policy_version!==POLICY) throw failure(503,'policy-unavailable');
    const parsed=outcomeSchema.safeParse(JSON.parse(row.outcome_json));
    if (!parsed.success || parsed.data.botId!==row.bot_id || parsed.data.operationId!==row.operation_id) throw failure(503,'policy-unavailable');
    const outcome=parsed.data;
    return outcome;
  };
  /** No await between clear, durable store flush and the completion transaction.
   * A retry reconciles cursor persistence only; it never runs the deletion policy. */
  const reconcile = (db:DatabaseSync,row:Operation):Outcome => {
    const outcome=stored(row);
    if (row.cursors_applied===1) {
      if (outcome.state==='applying') throw failure(503,'invalid-cursor-audit');
      return outcome;
    }
    if (row.installation!==installation(db)) throw failure(503,'installation-changed');
    const parsed=cursorAuditSchema.safeParse(JSON.parse(row.cursor_clears_json));
    if (!parsed.success || parsed.data.some(c=>c.botId!==row.bot_id) || outcome.state==='blocked') throw failure(503,'invalid-cursor-audit');
    const clears=parsed.data, b=deps.bot(row.bot_id);
    const slot = (clear:typeof clears[number]) => b?.tasks?.find(task=>task.threadId===clear.threadId);
    const stillHeld = (clear:typeof clears[number]) => {
      const task=slot(clear);
      return task?.resumeIncarnations?.[clear.instanceId]===clear.incarnation && JSON.stringify(task?.resumeCursors?.[clear.instanceId])===clear.cursorJson;
    };
    // JSON survives a restart; Store needs the LIVE value for its identity check.
    const currentClears=clears.filter(stillHeld).map(clear=>({botId:clear.botId,threadId:clear.threadId,instanceId:clear.instanceId,incarnation:clear.incarnation,cursor:slot(clear)!.resumeCursors![clear.instanceId]}));
    deps.clearCursors(currentClears);
    const pending:Outcome={...outcome,state:'applying',reason:'cursor-save-pending'};
    try {
      deps.flush(); // Must finish before flag/outcome completion, including recovery.
      const freshSessions=clears.filter(clear=>!stillHeld(clear)).length;
      const state=outcome.clearedBlocks || freshSessions ? 'done' : 'nothing-to-do';
      const completed=outcomeSchema.parse({...outcome,state,reason:state==='done'?null:'no-change',freshSessions});
      beginWrite(db,'gh18_cursor_completion');
      try {
        db.prepare('UPDATE gh18_operations SET cursors_applied=1,state=?,reason=?,completed_at=?,outcome_json=? WHERE operation_id=? AND cursors_applied=0')
          .run(state,completed.reason,now(),JSON.stringify(completed),row.operation_id);
        endWrite(db,'gh18_cursor_completion');
      } catch(error) { undoWrite(db,'gh18_cursor_completion'); throw error; }
      return completed;
    } catch {
      // T1 already stored this applying outcome. Preserve its operation id and
      // counts even if disk persistence or the completion transaction failed.
      return pending;
    }
  };
  const withGate = async <T>(id:string,run:()=>Promise<T>|T):Promise<T> => {
    if (gates.get(id)?.pending) throw failure(503,'operation-in-flight');
    const gate=createKeepAllRepairGate(false); gates.set(id,gate);
    try { return await run(); } finally { gate.finish('repaired'); gates.delete(id); }
  };
  const writer = async () => {
    const complete = await raceCeiling((deps.writerGate?.() ?? awaitWriterGate()).then(()=>true),WRITER_WAIT_MS);
    if (!complete || writersHeldForIndexBuild()) throw failure(503,'storage-busy');
  };
  return {
    pending: (id:string) => gates.get(id)?.pending === true,
    barrier: async (id:string) => { const gate=gates.get(id); if(gate) await keepAllRepairBarrier(gate); },
    /** Synchronous before listen. Keyset batches visit each pending row once,
     * including when one flush fails, so recovery never spins or skips later bots. */
    recover() {
      const db=deps.db(); if(!hasAudit(db)) return;
      let after='';
      for (;;) {
        const rows=db.prepare('SELECT * FROM gh18_operations WHERE installation=? AND cursors_applied=0 AND operation_id>? ORDER BY operation_id LIMIT 25').all(installation(db),after) as unknown as Operation[];
        if(!rows.length) return;
        for(const row of rows) {
          after=row.operation_id;
          const gate=createKeepAllRepairGate(false); gates.set(row.bot_id,gate);
          try {
            if(reconcile(db,row).state==='applying') console.warn(`[memory] gh18 fresh-start reconcile: cursor save pending op=${row.operation_id}`);
          } catch {
            console.warn(`[memory] gh18 fresh-start reconcile: cursor save pending op=${row.operation_id}`);
          } finally { gate.finish('repaired'); gates.delete(row.bot_id); }
        }
      }
    },
    async request(req:{botId:string;action:string;body?:unknown;authenticate():Owner|null}):Promise<{status:number;body:any}> {
      try {
        const caller=auth(req.authenticate), db=deps.db(), b=bot(req.botId), install=installation(db);
        if(req.action==='preview') {
          if(!previewRequest.safeParse(req.body).success) throw failure(400,'invalid-request');
          beginRead(db,'gh18_preview');
          let plan:FreshStartPlan, snap:string;
          try { plan=classify(db,b); snap=snapshot(db,b); endWrite(db,'gh18_preview'); }
          catch(error) { undoWrite(db,'gh18_preview'); throw error; }
          // Bound each owner session to 100 unused tokens, also evict all expired tokens.
          for(const [key,token] of tokens) if(token.expiresAt<=now()) tokens.delete(key);
          const own=[...tokens].filter(([,t])=>t.owner===caller.owner && t.session===caller.session);
          while(own.length>=100) tokens.delete(own.shift()![0]);
          const previewToken=randomUUID(), expiresAt=now()+TTL;
          tokens.set(digest(previewToken),{...caller,installation:install,botId:b.id,snapshot:snap,expiresAt});
          const state=plan.blocked ? 'blocked' : plan.sessionRows.length || plan.cursorClears.length ? 'ready' : 'nothing-to-do';
          return {status:200,body:{policyVersion:POLICY,botId:b.id,botName:b.name,state,reason:plan.blocked ?? (state==='nothing-to-do'?'no-change':null),staleBlocks:plan.sessionRows.length,freshSessions:plan.cursorClears.length,retainedBlocks:plan.retainedBlocks,retainedCapped:plan.retainedCapped,previewToken,expiresAt}};
        }
        if(req.action.startsWith('operations/')) return await withGate(b.id,async()=>{
          await writer(); const current=auth(req.authenticate); bot(b.id);
          if(!hasAudit(db)) throw failure(404,'no-such-operation');
          const row=db.prepare('SELECT * FROM gh18_operations WHERE operation_id=? AND installation=? AND owner=? AND bot_id=?').get(req.action.slice(11),installation(db),current.owner,b.id) as unknown as Operation|undefined;
          if(!row) throw failure(404,'no-such-operation');
          return {status:200,body:reconcile(db,row)};
        });
        if(req.action!=='confirm') throw failure(404,'no-such-route');
        const parsed=confirmRequest.safeParse(req.body); if(!parsed.success) throw failure(400,'invalid-request');
        const body=parsed.data;
        const requestDigest=digest({policyVersion:POLICY,botId:b.id,previewToken:body.previewToken,confirm:true,idempotencyKey:body.idempotencyKey});
        return await withGate(b.id,async()=>{
          await writer();
          beginWrite(db,'gh18_confirm');
          let row:Operation;
          try {
            // M2: authenticate -> durable key/digest -> token/snapshot/busy/policy. Do not reorder.
            const current=auth(req.authenticate), currentBot=bot(b.id), currentInstall=installation(db);
            const existing=hasAudit(db) ? db.prepare('SELECT * FROM gh18_operations WHERE installation=? AND owner=? AND bot_id=? AND idempotency_key=?').get(currentInstall,current.owner,b.id,body.idempotencyKey) as unknown as Operation|undefined : undefined;
            if(existing) {
              if(existing.request_digest!==requestDigest) throw failure(409,'idempotency-conflict');
              stored(existing); row=existing;
            } else {
              const token=tokens.get(digest(body.previewToken));
              if(!token || token.expiresAt<=now() || token.owner!==current.owner || token.session!==current.session || token.installation!==currentInstall || token.botId!==b.id || token.snapshot!==snapshot(db,currentBot)) throw failure(409,'stale-preview');
              // Schema admission failure is an error, not an unaudited terminal outcome.
              if(!deps.schemaCompatible()) throw failure(503,'unsupported-schema');
              const plan=classify(db,currentBot);
              const clearedBlocks=plan.blocked ? 0 : deps.policy!.applyFreshStartRows(db,plan);
              if(!Number.isSafeInteger(clearedBlocks) || clearedBlocks<0 || clearedBlocks>5000) throw failure(503,'policy-unavailable');
              const clears=plan.blocked ? [] : plan.cursorClears;
              const state=plan.blocked ? 'blocked' : clears.length ? 'applying' : clearedBlocks ? 'done' : 'nothing-to-do';
              const cursorAudit=clears.map(({botId,threadId,instanceId,cursor,incarnation})=>({botId,threadId,instanceId,cursorJson:JSON.stringify(cursor),incarnation}));
              if(clears.length && !cursorAuditSchema.safeParse(cursorAudit).success) throw failure(503,'policy-unavailable');
              const operationId=randomUUID();
              const outcome=outcomeSchema.parse({operationId,policyVersion:POLICY,botId:b.id,state,reason:plan.blocked ?? (state==='applying'?'cursor-save-pending':state==='nothing-to-do'?'no-change':null),clearedBlocks,freshSessions:clears.length,retainedBlocks:plan.retainedBlocks,retainedCapped:plan.retainedCapped,visibilityChanged:false});
              if (!outcomeSchema.safeParse(outcome).success) throw failure(503,'policy-unavailable');
              ensureGH18Operations(db);
              db.prepare(`INSERT INTO gh18_operations(operation_id,installation,owner,bot_id,idempotency_key,request_digest,policy_version,snapshot_digest,created_at,completed_at,state,reason,cleared_blocks,cursor_clears_json,cursors_applied,visibility_changed,outcome_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(operationId,currentInstall,current.owner,b.id,body.idempotencyKey,requestDigest,POLICY,token.snapshot,now(),state==='applying'?0:now(),state,outcome.reason,clearedBlocks,JSON.stringify(cursorAudit),clears.length?0:1,JSON.stringify(outcome));
              row=db.prepare('SELECT * FROM gh18_operations WHERE operation_id=?').get(operationId) as unknown as Operation;
            }
            endWrite(db,'gh18_confirm');
          } catch(error) { undoWrite(db,'gh18_confirm'); throw error; }
          tokens.delete(digest(body.previewToken));
          const outcome=reconcile(db,row);
          return {status:outcome.state==='applying'?202:200,body:outcome};
        });
      } catch(error) {
        const status=(error as {status?:number})?.status;
        return {status:status ?? 503,body:{error:status ? (error as Error).message : 'operation-unavailable'}};
      }
    },
  };
}
