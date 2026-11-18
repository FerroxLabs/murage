// BASE source is extracted verbatim at 292df98d, executed only in the isolated
// test container to freeze the 512-cell oracle. No candidate function labels it.
import {expect,it} from 'vitest';
import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Store} from './store.ts';
import {permissionLevel} from './thread-permissions-refresh.ts';
import {fixture} from './decision/fixture.ts';
const pinned=JSON.parse(readFileSync('server/decision/permission-base-source.json','utf8'));
// levelMove is a trusted BASE helper, not a policy supplied by the test caller.
const moveSource=ts.transpileModule(pinned.levelMove,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const baseMethod=Function('permissionLevel',`${moveSource}\nclass Baseline {${ts.transpileModule('class Holder {'+pinned.method+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText.match(/class Holder \{([\s\S]*)\}/)![1]}}\nreturn Baseline.prototype.setPermissionLevel;`)(permissionLevel);
const flags=(level:string)=>({autoApprove:level!=='ask',fullAccess:level==='full'||level==='unlimited',noLimits:level==='unlimited'});
function context(from:string,conv:string,count:number,owner:boolean){const bot:any={id:'b',...flags(from),tasks:Array.from({length:count},(_,i)=>({id:'task'+i,threadId:owner?'owner'+i:'other'+i,...flags(conv)}))};const events:any[]=[];return {bots:[bot],bot:()=>bot,recordRevision:0,saveBots:()=>{},emit:(e:any)=>events.push(e),events};}
// F7 adds provenance metadata; the frozen level/revision/event oracle stays intact.
function withoutInheritanceChoice(bot:any){
 const {permissionExplicit:_choice,tasks,...rest}=bot;
 return {...rest,tasks:tasks?.map(({permissionExplicit:_taskChoice,...task}:any)=>task)};
}
const cases:any[]=[];for(const from of ['ask','auto','full','unlimited'])for(const to of ['ask','auto','full','unlimited'])for(const conv of ['ask','auto','full','unlimited'])for(const mirror of [false,true])for(const count of [1,2])for(const owner of [false,true])cases.push({from,to,conv,mirror,count,owner});
it('R6 M30 X5 full 512-cell transition parity, including non-owner No-limits sole mirroring',()=>{
 const f=fixture();f.db.prepare("INSERT INTO memory_scopes VALUES('scope-other','conversation','other','[]',0)").run();for(let i=0;i<2;i++)f.db.prepare("INSERT INTO memory_scope_bindings VALUES(?, 'scope-other', 'human-thread', ?, 1, 'granted', ?)").run('human-thread:other'+i,'other'+i,JSON.stringify({personId:'other',bindingId:'fixture',revision:1}));
 const generated=cases.map(c=>{const ctx=context(c.from,c.conv,c.count,c.owner);baseMethod.call(ctx,'b',{flags:flags(c.to),mirrorSoleTask:c.mirror});return {case:c,bot:ctx.bot(),events:ctx.events};});
 const path='server/testing/fixtures/permission-level-base.json';
 if(process.env.RECORD_PERMISSION_BASE==='1')writeFileSync(path,JSON.stringify({commit:pinned.commit,sourceHash:createHash('sha256').update(pinned.method+pinned.levelMove).digest('hex'),rows:generated},null,2)+'\n');
 const frozen=JSON.parse(readFileSync(path,'utf8'));expect(frozen.rows).toHaveLength(512);expect(frozen.rows).toEqual(generated);
 for(const [index,c]of cases.entries()){
  const ctx=context(c.from,c.conv,c.count,c.owner);Store.prototype.setPermissionLevel.call(ctx as any,'b',{flags:flags(c.to),mirrorSoleTask:c.mirror});
  const base=frozen.rows[index];const involves=c.from!==c.to&&(c.from==='unlimited'||c.to==='unlimited');
  expect(ctx.bot().permissionExplicit).toBe(true);
  if(c.mirror&&c.count===1&&!(c.owner&&involves))expect(ctx.bot().tasks[0].permissionExplicit).toBe(true);
  if(c.owner&&involves)for(const task of ctx.bot().tasks)expect(permissionLevel(task)).toBe(c.to==='unlimited'?'no-limits':c.to);else expect(withoutInheritanceChoice(ctx.bot())).toEqual(base.bot);
  expect(ctx.events).toEqual(base.events);
 }
},45000);
