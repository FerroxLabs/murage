// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LearningEventKindV5 } from "./learning-kinds.ts";
import { readMemoryLearning } from "./learning-policy.ts";
export function recordLearningEvent(db:DatabaseSync,input:{kind:LearningEventKindV5;scopeId:string;recordId?:string;recordVersion?:number;sourceId?:string;sourceRevision?:number;botId?:string|null;connection?:string|null;priorId?:string;priorVersion?:number;detail?:Record<string,unknown>;now?:number}){
 const id=randomUUID();
 db.prepare(`INSERT INTO memory_learning_events(id,scope_id,kind,record_id,record_version,source_id,source_revision,bot_id,detail,prior_id,prior_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run(id,input.scopeId,input.kind,input.recordId??null,input.recordVersion??null,input.sourceId??null,input.sourceRevision??null,input.botId??null,JSON.stringify({connection:input.connection??null,...input.detail}),input.priorId??null,input.priorVersion??null,input.now??Date.now());return id;
}
const defaultRecorded=new WeakSet<DatabaseSync>();
export function recordDefaultLearningConnection(db:DatabaseSync,selected:string|null,keyPresent:boolean){
 if(defaultRecorded.has(db)||db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode==="off")return false;
 const settings=readMemoryLearning(db);
 if(selected||!keyPresent||!settings.automaticFacts&&!settings.automaticProcedures)return false;
 if(db.prepare("SELECT 1 FROM memory_learning_events WHERE kind='connection-defaulted'").get()){if(!db.isTransaction)defaultRecorded.add(db);return false;}
 const outer=db.isTransaction;
 db.exec("SAVEPOINT default_learning_connection");
 try{
 const meta=db.prepare("SELECT installation_id FROM memory_meta").get()!;
 let scope=db.prepare("SELECT id FROM memory_scopes WHERE kind='workspace' AND owner_key=?").get(meta.installation_id)?.id;
 if(!scope){scope=randomUUID();db.prepare("INSERT INTO memory_scopes VALUES(?,'workspace',?,'[]',0)").run(scope,meta.installation_id);}
 db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,detail,created_at) VALUES(?,?,'connection-defaulted',?,?)").run(randomUUID(),scope,JSON.stringify({connection:"@murage/flux-fast"}),Date.now());
 db.exec("RELEASE default_learning_connection");if(!outer)defaultRecorded.add(db);return true;
 }catch(error){db.exec("ROLLBACK TO default_learning_connection;RELEASE default_learning_connection");throw error;}
}
