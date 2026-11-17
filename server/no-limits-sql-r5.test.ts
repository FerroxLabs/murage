// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy inputs only; no database calls execute.
import {expect,it} from 'vitest';
import {sqlWipe,rawDatabaseWipe} from './no-limits-wipe-sql.ts';
import {nativeDatabaseWipe,mongoWipe} from './no-limits-database-input.ts';
import {describeOwnerNoLimits} from './decision/action.ts';
import {autoVerdict} from './auto-approve.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
const bot={autoApprove:true,fullAccess:true,noLimits:true};
const bad=['DELETE FROM t WHERE alwaysIN (1)','DROP/**/TABLE fixture','DELETE/**/FROM fixture',"DELETE FROM t WHERE CURRENT_USER <> ''","DELETE FROM t WHERE now() > '2000-01-01'",'DELETE FROM t WHERE 1 IN (1)',...['current_user','session_user','user','current_date','current_time','localtimestamp','now','true','false','null','select','from','where','current_role','current_schema','current_catalog','system_user'].map(x=>`DELETE FROM t WHERE ${x}=1`),'DELETE FROM t WHERE id>5','DELETE FROM t WHERE id=5 AND x=1','DELETE FROM t WHERE id=5; SELECT 1','DELETE FROM t WHERE id=5 -- comment',...['drop','truncate','delete','flushall','flushdb','dropdatabase','deletemany','remove('].map(x=>`SELECT 'xx${x}xx'`)];
bad.push('DELETE FROM t WHERE id=5;',"DELETE FROM t WHERE email IN ('a@x.com','b@x.com')");
const good=['SELECT * FROM t;','UPDATE t SET a=1 WHERE id=5;'];
for(const text of bad.concat(good))for(const mode of [false,true])it(`r5 SQL mode=${mode} ${text}`,()=>expect(sqlWipe(text,mode)).toBe(bad.includes(text)));
for(const text of bad.concat(good))for(const layer of ['direct','approval','registered','registered-unmounted'])it(`r5 MCP ${layer} ${text}`,()=>{
 // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: all original SQL inputs stay;
 // raw SQL detection above is separate from permission to run a database call.
 const tool='mcp__fixture__execute_sql',input={query:text},card=false;
 if(layer==='direct')return expect(describeOwnerNoLimits({tool,input}).deletes.length>0).toBe(card);
 if(layer==='approval')return expect(autoVerdict(bot,tool,'Fixture',{fullAccessOrigin:'owner',call:{toolCall:{name:tool,input}}}).approve===null).toBe(card);
 const f=fixture();try{expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);expect(d.decide(f.open('sql',input,{tool,toolCall:{name:tool,input},toolEngine:'claude',...(layer==='registered-unmounted'?{}:{mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]})}),baseRun).kind).toBe(card?'card':'run');}finally{f.dispose();}
});
for(const method of ['query','execute','exec','run','raw','unsafe','sql','deleteMany','deleteOne','remove','drop','bulkWrite','findOneAndDelete','eval'])for(const code of [`(db.${method})(sql)`,`const q=db.${method}; q(sql)`,`db["${method}"](sql)`,`db.${method}?.(sql)`,`db.${method}("SELECT 'xxdropxx'")`])it(`r5 method ${code}`,()=>expect(nativeDatabaseWipe(code,'js')).toBe(true));
it('r5 Mongo grouped delete and substring names card',()=>{expect(mongoWipe('(db.x.deleteMany)({})')).toBe(true);expect(rawDatabaseWipe('xxDELETEyy')).toBe(true);});

it('a real filesystem-root wipe still cards at authenticated No limits',()=>{
 const command='rm -rf /',input={command,cwd:'/w'},f=fixture();
 try{
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
  expect(autoVerdict(bot,'Bash',command,{fullAccessOrigin:'owner',commandCwd:'/w',workFolder:'/w',commandText:command}).approve).toBeNull();
  expect(d.decide(f.open('root-control',input),baseRun).kind).toBe('card');
 }finally{f.dispose();}
});
