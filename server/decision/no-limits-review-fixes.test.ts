// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {boundedProjection} from './bounds.ts';
import {guardEngineRelease} from './provider-release.ts';
// MAIN RULING D3: every padded shell command below exceeds 65536 bytes.
// Both tails retain CARD at ingress and release; native tool twins stay intact.
const padded=(tail:string)=>'#'+'x'.repeat(1_050_000)+'\n'+tail;
it.each(['rm -rf ~','echo ordinary'])('R1 full retained command at ingress: %s',async tail=>{
 const f=fixture(),h=f.open('large',{command:padded(tail)});
 const out=d.decide(h,baseRun);
 // MAIN RULING NARROW-WIPE: a long comment cannot card the ordinary tail; the literal home-wipe twin stays a card.
 expect(out.kind).toBe(tail==='rm -rf ~'?'card':'run');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
 f.dispose();
});
it.each(['rm -rf ~','echo ordinary'])('R1 full retained changed command at release without replacement: %s',async tail=>{
 const f=fixture(),h=f.open('large',{command:'echo initial'});expect(d.decide(h,baseRun).kind).toBe('run');
 f.publish(f.event('large',{command:padded(tail)}));
 // MAIN RULING NARROW-WIPE: final release checks the actual tail, independent of display size.
 expect(guardEngineRelease({threadId:'t',requestId:'large',turnId:'turn',providerInstanceId:'p'})).toBe(tail!=='rm -rf ~');
 const rows=d.openApprovals('t');expect(rows).toHaveLength(tail==='rm -rf ~'?1:0);
 if(rows.length)expect(rows[0]).toMatchObject({why:'wipe'});f.dispose();
});
for(const tool of ['remove_file','delete_files','delete_file'])for(const array of [false,true])it.each(['/','/w/notes'])(`R2 ${tool} array=${array} native deletion: %s`,async path=>{
 const f=fixture(),input=array?{paths:[path]}:{path};
 const h=f.open('native',input,{tool,toolCall:{name:tool,input}}),out=d.decide(h,baseRun);
 expect(out.kind).toBe(path==='/'?'card':'run');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}f.dispose();
});
it('R2 release rechecks native delete arrays introduced after ordinary ingress',()=>{
 const f=fixture(),input={paths:['/w/notes']},tool='delete_files';
 const h=f.open('native',input,{tool,toolCall:{name:tool,input}});expect(d.decide(h,baseRun).kind).toBe('run');
 expect(guardEngineRelease({threadId:'t',requestId:'native',turnId:'turn',providerInstanceId:'p'},{paths:['/']})).toBe(false);
 expect(d.openApprovals('t')[0]).toMatchObject({why:'wipe'});f.dispose();
});
it('R2 native delete effects survive metadata exceeding the display budget',async()=>{
 const f=fixture(),input={padding:'x'.repeat(1_050_000),paths:['/']},tool='delete_files';
 const h=f.open('native-long',input,{tool,toolCall:{name:tool,input}}),out=d.decide(h,baseRun);
 expect(out.kind).toBe('card');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
 f.dispose();
});
it.each(['Bash','delete_files'])('R1 complete visible input is checked even when the provider flags it truncated: %s',async tool=>{
 const f=fixture(),input=tool==='Bash'?{command:padded('rm -rf ~')}:{padding:'x'.repeat(1_050_000),paths:['/']};
 const h=f.open('visible-unread',input,{tool,toolCall:{name:tool,input},toolInputTruncated:true});
 const out=d.decide(h,baseRun);expect(out.kind).toBe('card');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
 f.dispose();
});
it.each(['Bash','delete_files'])('R1 truncated ordinary visible input still runs: %s',tool=>{
 const f=fixture(),input=tool==='Bash'?{command:padded('echo ordinary')}:{padding:'x'.repeat(1_050_000),paths:['/w/notes']};
 const h=f.open('visible-unread-safe',input,{tool,toolCall:{name:tool,input},toolInputTruncated:true});
 // MAIN RULING NARROW-WIPE: a truncation flag cannot card fully retained ordinary input.
 expect(d.decide(h,baseRun).kind).toBe('run');f.dispose();
});
it('R1 a changed flagged tail is rechecked when the display hash is unchanged',()=>{
 const f=fixture(),extra={toolInputTruncated:true};
 // MAIN RULING NARROW-WIPE: the ordinary prefix runs; the changed home wipe below still must hold.
 const h=f.open('visible-change',{command:padded('echo ordinary')},extra);expect(d.decide(h,baseRun).kind).toBe('run');
 f.publish(f.event('visible-change',{command:padded('rm -rf ~')},extra));
 expect(guardEngineRelease({threadId:'t',requestId:'visible-change',turnId:'turn',providerInstanceId:'p'})).toBe(false);
 expect(d.openApprovals('t')[0]).toMatchObject({why:'wipe'});f.dispose();
});
it('R2 flagged replacement native input cannot release a visible root deletion',()=>{
 const f=fixture(),input={paths:['/w/notes']},tool='delete_files';
 const h=f.open('flagged-native',input,{tool,toolCall:{name:tool,input},toolInputTruncated:true});expect(d.decide(h,baseRun).kind).toBe('run');
 expect(guardEngineRelease({threadId:'t',requestId:'flagged-native',turnId:'turn',providerInstanceId:'p'},{paths:['/']})).toBe(false);
 expect(d.openApprovals('t')[0]).toMatchObject({why:'wipe'});f.dispose();
});
it.each(['rm -rf /','rm -rf /w/ordinary'])("R1 retained replacement with unchanged display: %s",async command=>{
 const f=fixture(),h=f.open('wipe-identity',{command:padded('rm -rf ~')});
 try{
  const out=d.decide(h,baseRun);expect(out.kind).toBe('card');
  if(out.kind!=='card')throw Error('wipe card required');
  await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});
  await d.answerApproval(out.ref,{behavior:'allow'});expect(f.respond).toHaveBeenCalledOnce();
  const display=d.readApproval(out.ref.approvalId)!.inputHash;
  expect(boundedProjection({command:padded(command)})).toEqual(boundedProjection({command:padded('rm -rf ~')}));
  f.publish(f.event('wipe-identity',{command:padded(command)}));
  expect(guardEngineRelease({threadId:'t',requestId:'wipe-identity',turnId:'turn',providerInstanceId:'p'})).toBe(command!=='rm -rf /');
  if(command==='rm -rf /')expect(d.openApprovals('t')[0].inputHash).toBe(display);
  expect(d.openApprovals('t')).toMatchObject(command==='rm -rf /'?[{why:'wipe'}]:[]);expect(f.respond).toHaveBeenCalledOnce();
 }finally{f.dispose();}
});
it.each(['rm -rf ~','echo ordinary'])('R1 retained operations survive projected tool metadata loss: %s',async tail=>{
 const f=fixture(),input={command:padded(tail)};
 const h=f.open('metadata-loss',input,{tool:undefined,toolCall:{input,name:'Bash'}});
 const out=d.decide(h,baseRun);// MAIN RULING NARROW-WIPE: metadata bounds retain the complete ordinary/wipe tail distinction.
 expect(out.kind).toBe(tail==='rm -rf ~'?'card':'run');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}f.dispose();
});
it('R1 Full access keeps its existing projected-metadata handling',()=>{
 const f=fixture('full'),input={command:padded('echo ordinary')};
 const h=f.open('full-metadata-loss',input,{tool:undefined,toolCall:{input,name:'Bash'}});
 expect(d.decide(h,baseRun).kind).toBe('card');f.dispose();
});

// MAIN RULING 2026-11-13 narrow-wipe (Sean)
// D1: exercise both ingress and the last provider writer with complete raw SQL.
for(const tool of ['mcp__fixture__execute_sql','execute_sql','unknown_connector'])for(const position of ['tail','middle','literal','safe','statements','oversize'])it(`D1 raw ${tool} ${position}`,async()=>{
 const f=fixture(),padding='x'.repeat(position==='oversize'?17*1024*1024:1_050_000);
 const query=position==='safe'?`/*${padding}*/ SELECT 1`:position==='literal'?`SELECT '${padding}'; DROP DATABASE fixture`:position==='middle'?`/*${padding}*/ SELECT 1; DROP DATABASE fixture; /*${padding}*/ SELECT 2`:`/*${padding}*/ DROP DATABASE fixture`;
 const input=position==='statements'?{statements:[`/*${padding}*/ SELECT 1`,'DROP DATABASE fixture']}:{query};
 const extra={tool,toolCall:{name:tool,input},...(tool.startsWith('mcp__')?{toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]}:{})};
 const h=f.open('d1',input,extra),out=d.decide(h,baseRun);
 expect(out.kind).toBe('run'); // MAIN RULING 2026-11-13 narrow-wipe (Sean)

 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});expect(f.respond).not.toHaveBeenCalled();}
 f.dispose();
});
it.each(['tail','middle','safe','oversize'])('D1 raw SQL refreshed at provider release: %s',position=>{
 const f=fixture(),tool='mcp__fixture__execute_sql',mounts={toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]};
 const initial={query:'SELECT 1'},h=f.open('d1-release',initial,{tool,toolCall:{name:tool,input:initial},...mounts});expect(d.decide(h,baseRun).kind).toBe('run');
 const padding='x'.repeat(position==='oversize'?17*1024*1024:1_050_000),input={query:`/*${padding}*/ ${position==='safe'?'SELECT 1':'DROP DATABASE fixture;'}${position==='middle'?`/*${padding}*/ SELECT 2`:''}`};
 f.publish(f.event('d1-release',input,{tool,toolCall:{name:tool,input},...mounts}));
 expect(guardEngineRelease({threadId:'t',requestId:'d1-release',turnId:'turn',providerInstanceId:'p'})).toBe(true); // MAIN RULING 2026-11-13 narrow-wipe (Sean)

 expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});

for(const position of ['tail','safe','oversize'])it(`D1 complete service SQL ${position}`,async()=>{
 const f=fixture(),padding='x'.repeat(position==='oversize'?17*1024*1024:1_050_000),call={tool:'execute_sql',approval:f.serviceCall().approval,input:{query:`/*${padding}*/ ${position==='tail'?'DROP DATABASE fixture':'SELECT 1'}`}};
 const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call}),out=d.decide(h,baseRun);
 expect(out.kind).toBe('run'); // MAIN RULING 2026-11-13 narrow-wipe (Sean)

 if(out.kind==='card'){d.attachQueue(out.ref,{kind:'email',ref:'q',call});await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
 let executed=false;const result=await d.executeService(h,async registered=>{executed=true;expect(registered.input).toEqual(call.input);return 'inert fixture';});
 expect(executed).toBe(true);expect(result.kind).toBe('executed');
 f.dispose();
});
for(const [input,card]of [
 // MAIN RULING T6: executable SQL fields retain the database keyword scan.
 [{envelope:{arguments:{sql:`SELECT '${'x'.repeat(1_050_000)}; DROP DATABASE fixture'; SELECT 2`}}},true],
 [{envelope:{arguments:{sql:`SELECT '${'x'.repeat(1_050_000)}'; SELECT 2; DROP DATABASE fixture`}}},true],
 [{padding:'x'.repeat(17*1024*1024),query:'SELECT 1'},true],
] as const)it(`D1 complete nested or over-cap input cards=${card}`,async()=>{
 const f=fixture(),tool='unknown_connector',out=d.decide(f.open('nested',input,{tool,toolCall:{name:tool,input}}),baseRun);
 expect(out.kind).toBe('run'); // MAIN RULING 2026-11-13 narrow-wipe (Sean)
if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}f.dispose();
});

it('D1 an unread over-cap operation cannot be released by approving its projected card',async()=>{
 const f=fixture(),tool='execute_sql',input={query:'/*'+'x'.repeat(17*1024*1024)+'*/ SELECT 1'};
 // MAIN RULING 2026-11-13 narrow-wipe (Sean)
 const h=f.open('over-cap',input,{tool,toolCall:{name:tool,input}});
 expect(d.decide(h,baseRun).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledOnce();expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
