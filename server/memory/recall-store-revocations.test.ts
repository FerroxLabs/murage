// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (structural publication). Consumer owner: recall-scope-c (Fable authorization regressions).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { setExecutionStore } from '../execution-audience.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { Store } from '../store.ts';
import { teamIdFor } from '../team-identities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { assertMemoryAccess, backgroundMemoryScopes, ensureScope, legacyRecallScopes, memoryAccess, persistMemoryRoster } from './policy.ts';
import { prepareRecallContextSync } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode('active');});
afterEach(()=>{setExecutionStore(undefined as unknown as Store);closeDatabase();});
function world() {
  const store=new Store(()=>({instanceId:'fixture',model:'model'})),bot=store.createBot({name:'Reader'},{seedMessages:false});
  const task=store.createTask(bot.id,'Other',false)!,room=store.createGroup('Room',[bot.id]);
  setExecutionStore(store);store.finishSharingBoot();
  const registry=new InternalCapabilities(),generation=registry.begin(bot.id,bot.threadId);
  const token=registry.mint({botId:bot.id,threadId:bot.threadId,generation,depth:0,kind:'memory',skillAuthoring:false});
  const issue=()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>store);
  return {store,bot,task,room,issue};
}
it.each(['journal','boot'] as const)('F1 %s: plain saves never re-admit a removed room, deleted task or transferred thread',mode=>{
  for(const cause of ['room','delete','transfer'] as const) {
    const {store,bot,task,room,issue}=world();
    const other=store.createBot({name:'Other'},{seedMessages:false});
    if(mode==='journal') {const id=teamIdFor('Fixture team');database().prepare("UPDATE team_identities SET op='rename',op_label='Renamed',op_phase=1 WHERE team_id=?").run(id);}
    else (store as unknown as {memoryReady:boolean}).memoryReady=false;
    prepareRecallContextSync(bot.id,bot.threadId,store);const access=issue();
    const scope=ensureScope(cause==='room'?'room':'conversation',cause==='room'?room.id:task.threadId);
    expect(access.scopeIds).toContain(scope);
    if(cause==='room') {room.memberIds=[];store.patchGroup(room.id,{name:'Changed'});}
    if(cause==='delete')store.deleteTask(bot.id,task.threadId);
    if(cause==='transfer')store.patchBot(other.id,{tasks:[{...other.tasks![0],threadId:task.threadId}]});
    // Exercise byte-identical saves after the unreconciled plain write, including the former acknowledgement branch.
    const writer=store as unknown as {saveBots():void};writer.saveBots();writer.saveBots();
    expect(()=>assertMemoryAccess(access,scope),cause).toThrow();expect(()=>issue(),cause).toThrow('MEMORY_RECALL_UNAVAILABLE');
    if(mode==='journal')database().exec('UPDATE team_identities SET op=NULL');
  }
});
it.each(['sharedWith','individual','chiefOfStaff','chiefScope'] as const)('F2 partition input %s cannot reuse an old acknowledged audience',field=>{
  const {store,bot,issue}=world();store.patchBot(bot.id,{partitionedAt:1,sharedWith:{mode:'all',teams:[]}});
  prepareRecallContextSync(bot.id,bot.threadId,store);const access=issue();
  const patch=field==='sharedWith'?{sharedWith:{mode:'none' as const,teams:[]}}:field==='chiefScope'?{chiefScope:'workspace' as const}:{[field]:true};
  store.patchBot(bot.id,patch);
  expect(()=>assertMemoryAccess(access)).toThrow();
  prepareRecallContextSync(bot.id,bot.threadId,store);
  expect([...issue().scopeIds].sort()).toEqual([...new Set(legacyRecallScopes(bot.id,bot.threadId,store))].sort());
});
it('F3 a same-connection team retirement and project deletion invalidate background audience cache stamps',()=>{
  const {store,bot}=world(),team=teamIdFor('Away');
  store.patchBot(bot.id,{partitionedAt:1,tasks:bot.tasks!.map(task=>task.threadId===bot.threadId?{...task,sharedWork:{teamId:team,createdAt:1}}:task)});
  const scopes=()=>backgroundMemoryScopes(bot.id,bot.threadId,store),expected=()=>[...new Set(legacyRecallScopes(bot.id,bot.threadId,store))].sort();
  scopes();database().prepare('UPDATE team_identities SET retired_at=1 WHERE team_id=?').run(team);
  expect([...scopes()].sort()).toEqual(expected());
  const room=store.createGroup('Project',[bot.id]);database().prepare("INSERT INTO project_settings(group_id,mode,updated_at) VALUES(?,'ongoing',1)").run(room.id);
  const roomScopes=()=>backgroundMemoryScopes(bot.id,room.threadId,store);
  roomScopes();database().prepare('DELETE FROM project_settings WHERE group_id=?').run(room.id);
  expect([...roomScopes()].sort()).toEqual([...new Set(legacyRecallScopes(bot.id,room.threadId,store))].sort());
});
it('F4 dangling bot and room grants never enter membership',()=>{
  const {store,bot,room,issue}=world(),db=database();
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('dangling-bot','absent-bot-scope','bot',?,1,'granted','{}')").run(bot.id);
  db.prepare("INSERT INTO memory_scope_bindings VALUES('dangling-room','absent-room-scope','room',?,1,'granted','{}')").run(room.id);
  db.exec('PRAGMA foreign_keys=ON');
  prepareRecallContextSync(bot.id,bot.threadId,store);expect(issue().scopeIds).not.toContain('absent-bot-scope');
  prepareRecallContextSync(bot.id,room.threadId,store);
  const rows=db.prepare('SELECT scope_id FROM memory_recall_view_scopes').all();expect(rows.map(row=>row.scope_id)).not.toContain('absent-room-scope');
});

// Producer owner: store-patchbot (real structural saves); consumer owner: recall-scope-d (F5 revocation matrix).
it.each((['memory','plain'] as const).flatMap(mode=>(['member removal','thread transfer','bot delete'] as const).map(cause=>({mode,cause}))))(
  'F5 real Store $mode $cause refuses issued and fresh access to the revoked scope',({mode,cause})=>{
    const {store,bot,task,room,issue}=world();
    const other=store.createBot({name:'Recipient'},{seedMessages:false});
    const registry=new InternalCapabilities(),generation=registry.begin(bot.id,bot.threadId);
    const fresh=()=>{
      const token=registry.mint({botId:bot.id,threadId:bot.threadId,generation,depth:0,kind:'memory',skillAuthoring:false});
      return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>store);
    };
    if(mode==='plain')(store as unknown as {memoryReady:boolean}).memoryReady=false;
    prepareRecallContextSync(bot.id,bot.threadId,store);
    const access=issue(),scope=ensureScope(cause==='member removal'?'room':cause==='bot delete'?'bot':'conversation',
      cause==='member removal'?room.id:cause==='bot delete'?bot.id:task.threadId);
    expect(()=>assertMemoryAccess(access,scope)).not.toThrow();
    const revision=store.memoryRosterRevision;
    if(cause==='member removal')expect(store.patchGroup(room.id,{memberIds:[]})).not.toBeNull();
    if(cause==='thread transfer'){
      expect(store.patchBot(bot.id,{tasks:bot.tasks!.filter(candidate=>candidate.threadId!==task.threadId)})).not.toBeNull();
      expect(store.patchBot(other.id,{tasks:[...other.tasks!,task]})).not.toBeNull();
      expect(store.taskByThread(bot.id,task.threadId)).toBeUndefined();
      expect(store.taskByThread(other.id,task.threadId)?.threadId).toBe(task.threadId);
    }
    if(cause==='bot delete')expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.memoryRosterRevision).toBeGreaterThan(revision);
    const writer=store as unknown as {saveBots():void};writer.saveBots();writer.saveBots();
    expect(()=>assertMemoryAccess(access,scope)).toThrow();
    if(mode==='memory'&&cause!=='bot delete'){
      prepareRecallContextSync(bot.id,bot.threadId,store);
      const rebuilt=fresh();
      expect(rebuilt.scopeIds).not.toContain(scope);
      expect([...rebuilt.scopeIds].sort()).toEqual([...new Set(legacyRecallScopes(bot.id,bot.threadId,store))].sort());
      expect(()=>assertMemoryAccess(rebuilt,scope)).toThrow('MEMORY_SCOPE_DENIED');
    } else expect(()=>fresh()).toThrow(/MEMORY_(?:RECALL_UNAVAILABLE|SCOPE_DENIED)/);
    // A successful rebuild must not revive the issued capability either.
    expect(()=>assertMemoryAccess(access,scope)).toThrow();
  },
);

it('F2 generated same-roster decisions preserve the legacy oracle for every reader context',()=>{
  const {store,bot,task,room}=world(),other=store.createBot({name:'Peer'},{seedMessages:false});
  const away=store.createGroup('Away room',[bot.id,other.id]);
  const team=teamIdFor('Away');
  store.patchBot(bot.id,{partitionedAt:1,sharedWith:{mode:'all',teams:[]}});
  store.patchBot(other.id,{section:'Away'});
  store.patchGroup(away.id,{section:'Away'});
  // Property inputs include malformed duplicates and raw ordering changes. Bypass Store lookup caches here so
  // the independent legacy oracle observes those exact arrays, even before a structural save publishes them.
  const roster={bots:store.bots,groups:store.groups};
  const execution={...roster,bot:(id:string)=>roster.bots.find(candidate=>candidate.id===id)};
  setExecutionStore(execution as unknown as Store);
  const answer=()=>[...new Set(roster.bots.map(reader=>reader.id))].sort().flatMap(id=>{
    const reader=roster.bots.find(candidate=>candidate.id===id)!;
    const threads=[...new Set([reader.threadId,...(reader.tasks??[]).map(t=>t.threadId),...roster.groups.flatMap(g=>[g.threadId,...(g.tasks??[]).map(t=>t.threadId)])])].sort();
    return threads.flatMap(thread=>[false,true].map(flag=>[id,thread,flag,[...new Set(legacyRecallScopes(id,thread,roster,flag))].sort()]));
  });
  const mutations:Array<()=>void>=[
    ()=>{bot.name='Cosmetic';},
    ()=>{bot.sharedWith={mode:'none',teams:[]};},
    ()=>{bot.sharedWith={mode:'list',teams:[{id:team,name:'Away'}]};},
    ()=>{bot.individual=true;},()=>{bot.individual=false;},
    ()=>{bot.chiefOfStaff=true;},()=>{bot.chiefScope='workspace';},
    ()=>{bot.chiefOfStaff=false;bot.chiefScope=undefined;},
    ()=>{task.channelProjectDesk={groupId:room.id};},
    ()=>{task.sharedWork={teamId:team,createdAt:1};},
    ()=>{task.sharedWork!.quarantined=true;},
    ()=>{room.memberIds=[];},()=>{room.memberIds=[bot.id];},
    ()=>{room.partitionedFor={[bot.id]:{kind:'room'}};},
    ()=>{room.partitionedFor={[bot.id]:{kind:'team',teamId:team}};},
    ()=>{room.dm=true;room.dmAudience={kind:'isolated'};},
    ()=>{room.dmAudience={kind:'team',teamId:team};},
    ()=>{room.channelProject={goal:'Fixture project',status:'active',startedAt:1,updatedAt:1};},
    ()=>{bot.tasks=[...bot.tasks!,{...task,channelProjectDesk:undefined}];},
    ()=>{bot.tasks=[...bot.tasks!].reverse();},
    ()=>{store.bots.reverse();},()=>{store.groups.reverse();},
    ()=>{store.bots.push({...other,section:'Duplicate'});},()=>{store.bots.reverse();},
    ()=>{store.groups.push({...room,memberIds:[]});},()=>{store.groups.reverse();},
    ()=>{store.groups.push({...room,id:'alias-room',memberIds:[]});},()=>{store.groups.reverse();},
  ];
  let same=0,changed=0;
  for(const [index,mutate] of mutations.entries()){
    const before=answer();
    mutate();
    if(persistMemoryRoster(roster,()=>{})){
      same++;expect(answer(),`same decision at mutation ${index}`).toEqual(before);
    }else changed++;
  }
  expect(same).toBeGreaterThan(0);expect(changed).toBeGreaterThan(15);
});

it('F5 a departed project desk and delegated room reader retain the legacy narrowing',()=>{
  const {store,bot,room}=world();
  const desk=store.createTask(bot.id,'Desk',false)!;
  store.patchGroup(room.id,{channelProject:{goal:'Fixture project',status:'active',startedAt:1,updatedAt:1}});
  database().prepare("INSERT INTO project_settings(group_id,mode,updated_at) VALUES(?,'ongoing',1)").run(room.id);
  store.patchBot(bot.id,{partitionedAt:1,tasks:bot.tasks!.map(t=>t.threadId===desk.threadId?{...t,channelProjectDesk:{groupId:room.id}}:t)});
  const issue=(thread:string,notOwnerAudience=false)=>{
    const registry=new InternalCapabilities(),generation=registry.begin(bot.id,thread);
    const token=registry.mint({botId:bot.id,threadId:thread,generation,depth:0,kind:'memory',skillAuthoring:false,...(notOwnerAudience?{notOwnerAudience:true}:{})});
    return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>store);
  };
  for(const flag of [false,true]){
    prepareRecallContextSync(bot.id,room.threadId,store,flag);
    expect([...issue(room.threadId,flag).scopeIds].sort()).toEqual([...new Set(legacyRecallScopes(bot.id,room.threadId,store,flag))].sort());
  }
  prepareRecallContextSync(bot.id,desk.threadId,store);
  const old=issue(desk.threadId),scope=ensureScope('conversation',room.threadId);
  expect(old.scopeIds).toContain(scope);
  store.patchGroup(room.id,{memberIds:[]});
  expect(()=>assertMemoryAccess(old,scope)).toThrow();
  prepareRecallContextSync(bot.id,desk.threadId,store);
  const current=issue(desk.threadId);
  expect([...current.scopeIds].sort()).toEqual([...new Set(legacyRecallScopes(bot.id,desk.threadId,store))].sort());
  expect(current.scopeIds).not.toContain(scope);
});

it.each(['roster','task'] as const)('F2 %s ordering that narrows the legacy audience never acknowledges the old fingerprint',kind=>{
  const {store,bot,task,room}=world();
  const liveTask=store.taskByThread(bot.id,task.threadId)!;
  const reader={...bot,tasks:[...bot.tasks!]};
  const project={...room,section:'Away',channelProject:{goal:'Fixture project',status:'active' as const,startedAt:1,updatedAt:1}};
  const roster={bots:[reader],groups:kind==='roster'?[room,{...room,id:'alias-room',memberIds:[]}]:[project]};
  if(kind==='task'){
    reader.section='Home';reader.partitionedAt=1;
    reader.tasks=[{...liveTask,channelProjectDesk:{groupId:room.id}},{...liveTask,channelProjectDesk:undefined}];
    database().prepare("INSERT INTO project_settings(group_id,mode,updated_at) VALUES(?,'ongoing',1)").run(room.id);
  }
  // Observe the exact first-match arrays instead of Store's published lookup indexes.
  setExecutionStore({...roster,bot:(id:string)=>roster.bots.find(candidate=>candidate.id===id)} as unknown as Store);
  persistMemoryRoster(roster,()=>{});
  const thread=kind==='roster'?room.threadId:task.threadId;
  const before=[...new Set(legacyRecallScopes(bot.id,thread,roster))].sort();
  expect(before.length).toBeGreaterThan(0);
  if(kind==='roster')roster.groups.reverse();else reader.tasks.reverse();
  expect([...new Set(legacyRecallScopes(bot.id,thread,roster))].sort()).not.toEqual(before);
  expect(persistMemoryRoster(roster,()=>{})).toBe(false);
});
