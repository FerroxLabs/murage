// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { turnAudienceIsOwner } from "../owner-audience.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { memoryCaptureRoster,threadMemoryRoom } from "./capture-scope.ts";
import { learningDestination,LEARNING_WRITERS,type LearningTarget } from "./learning-destination.ts";
export type LearningWriteDecision={decision:"auto";scopeId:string}|{decision:"owner-approval"|"refused";reason:string};
export function learningWriteDecision(db:DatabaseSync,input:{writer:string;sourceId:string;sourceRevision:number;targetScopeId:string;evidenceScopeIds?:readonly string[];botId?:string;threadId?:string;target:LearningTarget}):LearningWriteDecision {
 if(!LEARNING_WRITERS.includes(input.writer))throw Error("UNREGISTERED_LEARNING_WRITER");
 const source=db.prepare("SELECT * FROM memory_sources WHERE id=? AND revision=?").get(input.sourceId,input.sourceRevision);
 if(!source||source.state!=="active")return {decision:"refused",reason:"source-gone"};
 if(!source.thread_id||!turnAudienceIsOwner(String(source.thread_id),{},db))return {decision:"refused",reason:"not-owner-audience"};
 const destination=learningDestination({...(input.botId?{botId:input.botId}:{}),threadId:input.threadId??String(source.thread_id),evidenceScopeIds:[...new Set([String(source.scope_id),...(input.evidenceScopeIds??[])])],target:input.target});
 if(!destination.ok)return {decision:destination.reason==="needs-owner-approval"?"owner-approval":"refused",reason:destination.reason};
 if(destination.scopeId!==undefined&&destination.scopeId!==input.targetScopeId)return {decision:"refused",reason:"cross-scope"};
 const scope=db.prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(input.targetScopeId);
 if(scope?.kind==="room"){
  const room=memoryCaptureRoster().groups.find(g=>g.id===scope.owner_key);
  if(room&&source.thread_id!==room.threadId){
   const threads=JSON.stringify([room.threadId,...(room.tasks??[]).map(t=>t.threadId)]);
   if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='human-thread' AND subject_id IN (SELECT value FROM json_each(?)) AND json_extract(intent,'$.personId')!=? LIMIT 1").get(threads,WORKSPACE_OWNER))return {decision:"owner-approval",reason:"private-into-shared"};
  }
 }
 return {decision:"auto",scopeId:destination.scopeId??input.targetScopeId};
}
export function learningSourceBot(thread:string|null){
 if(!thread||threadMemoryRoom(thread))return undefined;
 return memoryCaptureRoster().bots.find(b=>b.threadId===thread||b.tasks?.some(t=>t.threadId===thread));
}
export function learningEvidenceScopes(db:DatabaseSync,recordId:string,version:number):string[]{
 return db.prepare("SELECT DISTINCT s.scope_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?").all(recordId,version).map(row=>String(row.scope_id));
}
