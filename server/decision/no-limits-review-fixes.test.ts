// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
const padded=(tail:string)=>'#'+'x'.repeat(1_050_000)+'\n'+tail;
it.each(['rm -rf ~','echo ordinary'])('R1 full retained command at ingress: %s',async tail=>{
 const f=fixture(),h=f.open('large',{command:padded(tail)});
 const out=d.decide(h,baseRun);
 expect(out.kind).toBe(tail.startsWith('rm')?'card':'run');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
 f.dispose();
});
it.each(['rm -rf ~','echo ordinary'])('R1 full retained changed command at release without replacement: %s',async tail=>{
 const f=fixture(),h=f.open('large',{command:'echo initial'});expect(d.decide(h,baseRun).kind).toBe('run');
 f.publish(f.event('large',{command:padded(tail)}));
 expect(guardEngineRelease({threadId:'t',requestId:'large',turnId:'turn',providerInstanceId:'p'})).toBe(!tail.startsWith('rm'));
 const rows=d.openApprovals('t');expect(rows).toHaveLength(tail.startsWith('rm')?1:0);
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
