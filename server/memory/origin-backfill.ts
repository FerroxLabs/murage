// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import type { RoutineRun } from "../routines.ts";
/** Bind metadata beside immutable source versions, preserving hashes and evidence revisions. */
export function backfillMemoryOrigins(db:DatabaseSync,runs:Pick<RoutineRun,"threadId"|"triggerSource"|"manual"|"routineId"|"webhookId"|"telegramConnectionId"|"channelOrigin">[],limit=100){
 const marker="memory-origin-backfill",previous=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(marker);
 const progress=previous?JSON.parse(String(previous.intent)):{cursor:""};if(progress.done)return {done:true};
 const origins=new Map<string,Set<string>>();
 for(const run of runs){if(!run.threadId)continue;const kinds=origins.get(run.threadId)??new Set<string>();kinds.add(run.triggerSource??(run.manual?"manual":"schedule"));origins.set(run.threadId,kinds);}
 // A row that already carries an origin (in its payload, or a binding from an earlier window)
 // is filtered where the data lives; its payload never reaches this function.
 const rows=db.prepare(`SELECT s.id,s.scope_id,s.thread_id FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
  WHERE s.id>? AND s.speaker='owner' AND s.kind='text' AND s.state!='deleted'
  AND (json_extract(v.payload,'$.origin') IS NULL OR json_extract(v.payload,'$.origin') IN (0,''))
  AND NOT EXISTS(SELECT 1 FROM memory_scope_bindings b WHERE b.id='source-origin:'||s.id) ORDER BY s.id LIMIT ?`).all(progress.cursor,Math.min(500,Math.max(1,limit)));
 for(const row of rows){
  const kinds=origins.get(String(row.thread_id));if(kinds?.size!==1)continue;
  const kind=[...kinds][0];if(!["schedule","manual","webhook","channel"].includes(kind))continue;
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES(?,?,'source-origin',?,0,'granted',?)").run(`source-origin:${row.id}`,row.scope_id,row.id,JSON.stringify({kind}));
 }
 const scope=rows[0]?.scope_id??db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
 const done=rows.length<Math.min(500,Math.max(1,limit));
 if(scope)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','origin-backfill',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(marker,scope,JSON.stringify({cursor:rows.at(-1)?.id??progress.cursor,done}));
 return {done};
}
