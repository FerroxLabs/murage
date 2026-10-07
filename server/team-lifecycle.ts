import { interruptSharedThread } from "./shared-work.ts";
import { validateSharingStructure } from "./sharing-restore.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { writeFileAtomic } from "./atomic.ts";
import { type BotRecord, type GroupRecord, type Store, sectionKey, isWorkspaceChief } from "./store.ts";
import { TEAM_JOURNAL, TEAM_RENAME_STALLED, assertSectionUnlocked, markTeamRenameStalled, parseTeamOpRecords, teamIdFor, workThreadTitle } from "./team-identities.ts";
import { completeRequest, roomRequest } from "./room-requests.ts";
import { sharedWithTeam } from "./execution-audience.ts";
import { reconcileMemoryRoster } from "./memory/policy.ts";
import { revokeAllDisclosures } from "./memory/revocation.ts";
let checkpoint: ((phase:string)=>void) | undefined;
export function setTeamJournalCheckpoint(hook:typeof checkpoint):void {checkpoint=hook;}
const check=(phase:string)=>checkpoint?.(phase);
interface JournalFiles {
 bots:BotRecord[];groups:GroupRecord[];root:string;
 botsPatch(patches:Map<string,Partial<BotRecord>>):void;
 groupsPatch(patches:Map<string,Partial<GroupRecord>>):void;
}
function liveFiles(store:Store):JournalFiles {return {bots:store.bots,groups:store.groups,root:DATA_DIR,botsPatch:p=>store.applyTeamChange(p,new Map(),TEAM_JOURNAL),groupsPatch:p=>store.applyTeamChange(new Map(),p,TEAM_JOURNAL)};}
function contexts(root:string):{version:1;contexts:Record<string,{text:string;updatedAt:number}>} {const path=join(root,"section-contexts.json");return existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{version:1,contexts:{}};}
function clearJournal(db:DatabaseSync,id:string){db.prepare("UPDATE team_identities SET op=NULL,op_label=NULL,op_choice=NULL,op_phase=NULL,op_records=NULL,op_since=NULL,updated_at=? WHERE team_id=?").run(Date.now(),id);}
function scope(db:DatabaseSync,key:string){return db.prepare("SELECT id FROM memory_scopes WHERE kind='team' AND owner_key=?").get(key);}
function moveMemory(db:DatabaseSync,from:string,to:string){
 if(!scope(db,from))return;
 if(scope(db,to))throw new Error(TEAM_RENAME_STALLED);
 db.exec("SAVEPOINT team_memory_move");try{db.prepare("UPDATE memory_scopes SET owner_key=?,revision=revision+1 WHERE kind='team' AND owner_key=?").run(to,from);db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");revokeAllDisclosures(db,"team-move");db.exec("RELEASE team_memory_move");}catch(e){db.exec("ROLLBACK TO team_memory_move; RELEASE team_memory_move");throw e;}
}
function referenced(files:JournalFiles,db:DatabaseSync,id:string){return files.bots.some(b=>b.sharedWith?.teams.some(t=>t.id===id)||b.tasks?.some(t=>t.sharedWork?.teamId===id))||files.groups.some(g=>g.dmAudience?.kind==="team"&&g.dmAudience.teamId===id||Object.values(g.partitionedFor??{}).some(m=>m.kind==="team"&&m.teamId===id))||!!db.prepare("SELECT 1 FROM room_requests WHERE json_extract(execution_audience,'$.team')=? AND state IN ('queued','running','waiting_owner','waiting_bot')").get(id);}
function renamePrecheck(files:JournalFiles,db:DatabaseSync,to:string):void {
 if(scope(db,to)||contexts(files.root).contexts[to]||[...files.bots,...files.groups].some(r=>sectionKey(r.section)===to))throw Object.assign(new Error(`There is already a team named ${to}.`),{status:409});
 const old=db.prepare("SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL").get(to);
 if(old){if(referenced(files,db,String(old.team_id)))throw Object.assign(new Error(`An earlier team named ${to} still has work on record. Choose another name.`),{status:409});db.prepare("UPDATE team_identities SET retired_at=? WHERE team_id=?").run(Date.now(),old.team_id);}
}
export function beginTeamJournal(store:Store,from:string,to:string|undefined,choice?:"keep"|"archive"):string|null {
 const db=database(),files=liveFiles(store),op=choice?"delete":"rename";
 // The owner's retry of a stalled rename re-enters its journal (V5 both-present).
 // A new name rewrites the journal's target, checked like any rename, and carries it forward.
 const stalled=choice?undefined:db.prepare("SELECT team_id,op_label FROM team_identities WHERE op='rename' AND label=? AND retired_at IS NULL").get(from);
 if(stalled){const id=String(stalled.team_id),target=String(stalled.op_label),renamed=!!to&&to!==from&&to!==target&&!!scope(db,from)&&!!scope(db,target);
  if(renamed){renamePrecheck(files,db,to!);db.prepare("UPDATE team_identities SET op_label=?,op_phase=1,updated_at=? WHERE team_id=?").run(to,Date.now(),id);}
  retryJournal(files,db,id,!renamed);store.markPartitions();
  const now=db.prepare("SELECT label,op FROM team_identities WHERE team_id=?").get(id);if(now?.op!==null||now.label!==from||from===to)return id;}
 assertSectionUnlocked();
 if(!choice){if(!to)throw new Error("Missing team name");renamePrecheck(files,db,to);}
 if(legacyLabel(files,db,from)){legacyTeamChange(store,files,db,from,to,choice);return null;}
 const id=teamIdFor(from),now=Date.now(),records={bots:files.bots.filter(b=>sectionKey(b.section)===from).map(b=>b.id),groups:files.groups.filter(g=>sectionKey(g.section)===from).map(g=>g.id)};
 const label=choice?`deleted-team:${new Date(now).toISOString()}:${randomUUID()}:${from}`:to!;
 db.exec("SAVEPOINT open_team_journal");
 try {
  db.prepare("UPDATE team_identities SET op=?,op_label=?,op_choice=?,op_phase=1,op_records=?,op_since=?,updated_at=? WHERE team_id=?").run(op,label,choice??null,JSON.stringify(records),now,now,id);
  if(choice)for(const row of db.prepare("SELECT id FROM room_requests WHERE json_extract(execution_audience,'$.team')=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(id))completeRequest(db,String(row.id),{state:"cancelled",now,outcomeNote:"team-deleted"});
  db.exec("RELEASE open_team_journal");
 }catch(error){db.exec("ROLLBACK TO open_team_journal; RELEASE open_team_journal");throw error;}
 if(choice)for(const bot of files.bots)for(const task of bot.tasks??[])if(task.sharedWork?.teamId===id||records.bots.includes(bot.id)&&task.sharedWork)interruptSharedThread(task.threadId);
 check(`${op}:1`);runJournal(files,db,id,false);store.markPartitions();return id;
}
/** A legacy label over 60 characters has no identity and can never hold one (N2), so no
 * work thread, request or list entry can name it: `all` mode covers it by its label only,
 * which follows the rename. Its rename and delete take the earlier direct path, with no
 * journal; the section lock was already checked. */
function legacyLabel(files:JournalFiles,db:DatabaseSync,label:string):boolean {
 return label.length>60&&!db.prepare("SELECT 1 FROM team_identities WHERE label=?").get(label)&&!files.bots.some(b=>b.sharedWith?.teams.some(t=>t.name===label));
}
function legacyTeamChange(store:Store,files:JournalFiles,db:DatabaseSync,from:string,to:string|undefined,choice?:"keep"|"archive"):void {
 const now=Date.now(),target=choice?`deleted-team:${new Date(now).toISOString()}:${randomUUID()}:${from}`:to!;
 moveMemory(db,from,target);
 const bots=new Map<string,Partial<BotRecord>>();for(const b of files.bots){if(sectionKey(b.section)!==from)continue;
  if(!choice){bots.set(b.id,{section:to});continue;}
  // A deleted team's bots stop sharing and their open work closes, as the journal does.
  const tasks=b.tasks?.some(t=>t.sharedWork&&t.sharedWork.closedAt===undefined)?structuredClone(b.tasks):undefined;
  for(const task of tasks??[])if(task.sharedWork&&task.sharedWork.closedAt===undefined){for(const r of db.prepare("SELECT id FROM room_requests WHERE target_thread_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(task.threadId))completeRequest(db,String(r.id),{state:"cancelled",now,outcomeNote:"team-deleted"});interruptSharedThread(task.threadId);task.sharedWork.closedAt=now;task.sharedWork.closedReason="revoked";delete task.sharedWork.finishing;}
  bots.set(b.id,{section:undefined,...(!isWorkspaceChief(b)?{chiefOfStaff:false,...(choice==="archive"?{hidden:true}:{})}:{}),...(b.sharedWith&&b.sharedWith.mode!=="none"?{sharedWith:{mode:"none" as const,teams:[]}}:{}),...(tasks?{tasks}:{})});}
 const groups=new Map<string,Partial<GroupRecord>>();for(const g of files.groups)if(sectionKey(g.section)===from)groups.set(g.id,choice?{section:undefined,...(choice==="archive"&&!g.dm?{hidden:true}:{})}:{section:to,...(!g.dm&&g.name===from?{name:to}:{})});
 store.applyTeamChange(bots,groups,TEAM_JOURNAL);
 const brief=contexts(files.root);if(brief.contexts[from]){if(!choice)brief.contexts[to!]=brief.contexts[from];delete brief.contexts[from];writeFileAtomic(join(files.root,"section-contexts.json"),JSON.stringify(brief),{mode:0o600});}
 store.markPartitions();
}
function retryJournal(files:JournalFiles,db:DatabaseSync,id:string,recovery=true):boolean {
 try{runJournal(files,db,id,recovery);markTeamRenameStalled(id,false);return true;}
 catch(error){if(!(error instanceof Error)||error.message!==TEAM_RENAME_STALLED)throw error;markTeamRenameStalled(id,true);throw Object.assign(error,{status:409});}
}
function runJournal(files:JournalFiles,db:DatabaseSync,id:string,recovery:boolean):void {
 const row=db.prepare("SELECT * FROM team_identities WHERE team_id=? AND op IS NOT NULL").get(id);if(!row)return;
 const op=String(row.op),from=String(row.label),to=String(row.op_label),records=parseTeamOpRecords(String(row.op_records)),now=Number(row.op_since),deleting=op==="delete";
 if(!deleting&&recovery&&from!==to){const a=scope(db,from),b=scope(db,to);if(a&&b)throw new Error(TEAM_RENAME_STALLED);if(a&&!b){clearJournal(db,id);return;}}
 const phase=(n:number)=>{db.prepare("UPDATE team_identities SET op_phase=?,updated_at=? WHERE team_id=?").run(n,Date.now(),id);check(`${op}:${n}`);};
 if(deleting){for(const r of db.prepare("SELECT id,target_thread_id FROM room_requests WHERE json_extract(execution_audience,'$.team')=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(id)){if(files.root===DATA_DIR&&r.target_thread_id)interruptSharedThread(String(r.target_thread_id));completeRequest(db,String(r.id),{state:"cancelled",now,outcomeNote:"team-deleted"});}}
 if(from!==to)moveMemory(db,from,to);phase(2);
 const bots=new Map<string,Partial<BotRecord>>();for(const b of files.bots)if(records.bots.includes(b.id)&&sectionKey(b.section)===from)bots.set(b.id,deleting?{section:undefined,...(!isWorkspaceChief(b)?{chiefOfStaff:false,...(row.op_choice==="archive"?{hidden:true}:{})}:{})}:{section:to});
 files.botsPatch(bots);check(`${op}:bots`);
 const groups=new Map<string,Partial<GroupRecord>>();for(const g of files.groups)if(records.groups.includes(g.id)&&sectionKey(g.section)===from)groups.set(g.id,deleting?{section:undefined,...(row.op_choice==="archive"&&!g.dm?{hidden:true}:{})}:{section:to,...(!g.dm&&g.name===from?{name:to}:{})});
 files.groupsPatch(groups);phase(3);
 const brief=contexts(files.root);if(from!==to&&brief.contexts[from]){if(!deleting&&!brief.contexts[to])brief.contexts[to]=brief.contexts[from];delete brief.contexts[from];writeFileAtomic(join(files.root,"section-contexts.json"),JSON.stringify(brief),{mode:0o600});}phase(4);
 if(!deleting){db.prepare("UPDATE team_identities SET label=?,memory_key=?,op_phase=5 WHERE team_id=?").run(to,to,id);check("rename:5");}
 const refresh=new Map<string,Partial<BotRecord>>();for(const bot of files.bots){const next=structuredClone(bot);let changed=false;
  if(!deleting&&from!==to)for(const task of next.tasks??[])if(task.sharedWork?.teamId===id&&task.title===workThreadTitle(next.name,from)){task.title=workThreadTitle(next.name,to);changed=true;}
  if(next.sharedWith){if(deleting&&records.bots.includes(next.id)){next.sharedWith={mode:"none",teams:[]};changed=true;}else if(next.sharedWith.teams.some(t=>t.id===id)){next.sharedWith.teams=deleting?next.sharedWith.teams.filter(t=>t.id!==id):next.sharedWith.teams.map(t=>t.id===id?{id,name:to}:t);changed=true;}}
  if(deleting)for(const task of next.tasks??[])if(task.sharedWork&&(task.sharedWork.teamId===id||records.bots.includes(next.id))){for(const r of db.prepare("SELECT id FROM room_requests WHERE target_thread_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(task.threadId))completeRequest(db,String(r.id),{state:"cancelled",now,outcomeNote:"team-deleted"});if(files.root===DATA_DIR)interruptSharedThread(task.threadId);task.sharedWork.closedAt=now;task.sharedWork.closedReason=task.sharedWork.teamId===id?"team-deleted":"revoked";delete task.sharedWork.finishing;changed=true;}
  if(changed)refresh.set(next.id,{...(next.sharedWith?{sharedWith:next.sharedWith}:{}),tasks:next.tasks});
 }
 files.botsPatch(refresh);
 if(deleting){phase(5);db.prepare("UPDATE team_identities SET retired_at=?,memory_key=?,op_phase=6 WHERE team_id=?").run(now,to,id);check("delete:6");}else check("rename:6");
 clearJournal(db,id);
}
export const TEAM_RENAME_ROLLED_BACK="A team rename could not finish; the team keeps its earlier name.";
/** A restored stalled rename (V5 both-present) goes back to its earlier name: its bots and channels return to the `from` label and the journal closes. Memory scopes are left as they are. */
function rollBackRename(files:JournalFiles,db:DatabaseSync,id:string):void {
 const row=db.prepare("SELECT label,op_label,op_records FROM team_identities WHERE team_id=?").get(id)!;
 const from=String(row.label),to=String(row.op_label),records=parseTeamOpRecords(String(row.op_records));
 const bots=new Map<string,Partial<BotRecord>>();for(const b of files.bots)if(records.bots.includes(b.id)&&sectionKey(b.section)===to)bots.set(b.id,{section:from});files.botsPatch(bots);
 const groups=new Map<string,Partial<GroupRecord>>();for(const g of files.groups)if(records.groups.includes(g.id)&&sectionKey(g.section)===to)groups.set(g.id,{section:from,...(!g.dm&&g.name===to?{name:from}:{})});files.groupsPatch(groups);
 clearJournal(db,id);
}
export function reconcileTeamJournalFiles(root:string,db:DatabaseSync,bots:BotRecord[],groups:GroupRecord[]):string[] {
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='team_identities'").get())return [];
 const notes:string[]=[];
 const apply=<T extends {id:string}>(rows:T[],patches:Map<string,Partial<T>>)=>{for(const row of rows){const patch=patches.get(row.id);if(!patch)continue;Object.assign(row,patch);for(const [k,v]of Object.entries(patch))if(v===undefined)delete (row as Record<string,unknown>)[k];}};
 const files:JournalFiles={root,bots,groups,botsPatch:p=>{apply(bots,p);writeFileAtomic(join(root,"bots.json"),JSON.stringify(bots),{mode:0o600});},groupsPatch:p=>{apply(groups,p);writeFileAtomic(join(root,"groups.json"),JSON.stringify(groups),{mode:0o600});}};
 for(const row of db.prepare("SELECT team_id FROM team_identities WHERE op IS NOT NULL").all())try{runJournal(files,db,String(row.team_id),true);}
  catch(error){if(!(error instanceof Error)||error.message!==TEAM_RENAME_STALLED)throw error;rollBackRename(files,db,String(row.team_id));notes.push(TEAM_RENAME_ROLLED_BACK);}
 return notes;
}
export function reconcileTeamIdentities(store:Store):string[] {
 const notes:string[]=[];
 const db=database();validateSharingStructure(store.bots as unknown as Record<string,unknown>[],store.groups as unknown as Record<string,unknown>[],db);
 // A stalled rename keeps its journal and never stops the boot; the owner renames it again.
 for(const row of db.prepare("SELECT team_id FROM team_identities WHERE op IS NOT NULL").all())try{retryJournal(liveFiles(store),db,String(row.team_id));}catch(error){if((error as {status?:number}).status!==409)throw error;notes.push(TEAM_RENAME_STALLED);}
 for(const bot of store.bots){let changed=false;
  if(bot.partitionedAt===undefined&&(bot.tasks?.some(t=>t.sharedWork)||store.groups.some(g=>g.partitionedFor?.[bot.id]||g.dmAudience&&g.memberIds.includes(bot.id)))){bot.partitionedAt=Date.now();changed=true;notes.push(`Inferred partitioning for ${bot.id} from preserved work markers.`);}
  if(bot.sharedWith?.mode==="list"){const teams=bot.sharedWith.teams.filter(t=>db.prepare("SELECT 1 FROM team_identities WHERE team_id=? AND retired_at IS NULL").get(t.id)).map(t=>({id:t.id,name:String(db.prepare("SELECT label FROM team_identities WHERE team_id=?").get(t.id)!.label)}));if(JSON.stringify(teams)!==JSON.stringify(bot.sharedWith.teams)){bot.sharedWith={...bot.sharedWith,teams};changed=true;}}
  for(const task of bot.tasks??[]){const work=task.sharedWork;if(!work)continue;
   if(!sharedWithTeam(bot,work.teamId)&&work.closedAt===undefined){work.closedAt=Date.now();work.closedReason=db.prepare("SELECT 1 FROM team_identities WHERE team_id=? AND retired_at IS NULL").get(work.teamId)?"revoked":"team-deleted";changed=true;}
   if(work.finishing){const run=work.finishing.requestId?roomRequest(db,work.finishing.requestId):null;if(!run||["done","failed","cancelled","expired","unknown"].includes(run.state)){delete work.finishing;changed=true;}}
  }
  if(changed)store.patchBot(bot.id,{sharedWith:bot.sharedWith,partitionedAt:bot.partitionedAt,tasks:bot.tasks});
 }
 validateSharingStructure(store.bots as unknown as Record<string,unknown>[],store.groups as unknown as Record<string,unknown>[],db);
 store.markPartitions();reconcileMemoryRoster(store);return notes;
}
