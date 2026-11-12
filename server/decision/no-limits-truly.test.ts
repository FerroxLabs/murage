// SPDX-License-Identifier: AGPL-3.0-or-later
// G-NL: Sean 2026-11-12 02:05Z supersedes every protected/deny-card design.
import {expect,it} from 'vitest';
import {d,fixture,baseCard,baseRun} from './fixture.ts';
import {autoVerdict} from '../auto-approve.ts';
const nl={autoApprove:true,fullAccess:true,noLimits:true};
// W3: final unresolved eval now cards; these unread compound fixtures retain their original run purpose.
const replay=[
 ['F1 outside-turn','touch notes.md',{outsideRead:['web page']}],
 ['F2 unreadable','eval "$OPAQUE"; echo ok',{}],
 ['F3 key-row','printf x > ~/.ssh/id_ed25519',{}],
 ['F3 protected-path','touch /etc/fixture',{}],
 ['F3 home-glob','ls ~/*',{}],
 ['F4 truncated','printf ok',{inputTruncated:true}],
 ['F4 U19','PAGER=less git log',{}],
 ['F5 refusal','mystery-tool /etc',{}],
 ['F6 no-grant','touch notes.md',{routineLevel:true,unattended:true}],
] as const;
for(const [id,command,extra]of replay)it(`live-replay ${id} reaches final registered run`,()=>{
 const f=fixture();const h=f.open('r',{command,cwd:'/tmp/fixture'},{toolInputTruncated:id.includes('truncated')});
 const out=d.decide(h,()=>autoVerdict(nl,'Bash',command,{fullAccessOrigin:'owner',ownerStarted:true,commandText:command,commandCwd:'/tmp/fixture',...extra}));
 expect(out.kind).toBe('run');expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
for(const path of ['~/.ssh/id_ed25519','/etc/fixture'])it(`live-replay key/protected edit ${path} runs`,()=>{
 const f=fixture();expect(d.decide(f.open('r',{path,content:'fixture'},{tool:'Write',toolCall:{name:'Write',input:{path,content:'fixture'}}}),baseCard).kind).toBe('run');f.dispose();
});
for(const denied of ['host-computer','browser-site','connected-app','protected-target'])it(`08:05 F5 ${denied} stored permission rule runs without a card`,()=>{
 const f=fixture();f.deny([{kind:'deny',class:denied,ruleId:'fixture-rule',span:'fixture'}]);
 expect(d.decide(f.open(),baseCard).kind).toBe('run');expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
for(const command of ['rm -rf ~','rm -rf /','rm -rf /tmp/fixture','mkfs.ext4 /dev/fixture','git push --force origin HEAD:main',"psql -c 'DROP TABLE fixture'",'rm -rf ~/backups'])
for(const shape of ['plain','tainted','unreadable']as const)it(`live-replay wipe ${shape} ${command} cards`,async()=>{
 const f=fixture();const text=shape==='unreadable'?`eval "$OPAQUE"; ${command}`:command;
 const h=f.open('r',{command:text,cwd:'/tmp/fixture'},{toolInputTruncated:shape==='unreadable'});
 const out=d.decide(h,()=>autoVerdict(nl,'Bash',text,{fullAccessOrigin:'owner',ownerStarted:true,commandText:text,commandCwd:'/tmp/fixture',outsideRead:shape==='tainted'?['web page']:null}));
 expect(out.kind).toBe('card');if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe fixture',subtitle:'Inert command'});expect(d.readApproval(out.ref.approvalId)?.why).toBe('wipe');}f.dispose();
});
it('F5 own-tool service runs despite a stored denial',()=>{
 const f=fixture();f.deny([{kind:'deny',class:'service',ruleId:'fixture',span:'fixture'}]);
 const call={...f.serviceCall({path:'/etc/fixture'}),tool:'mcp__murage__publish_site'};
 expect(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard).kind).toBe('run');f.dispose();
});
it('a reader overflow alone runs, while a visible tail wipe cards',()=>{
 const f=fixture();for(const [id,tail,expected]of [['safe','touch /etc/fixture','run'],['wipe','rm -rf ~','card']]as const){
 const command='echo fixture;'.repeat(6000)+tail;
 expect(d.decide(f.open(id,{command,cwd:'/tmp/fixture'}),baseCard).kind).toBe(expected);
 }f.dispose();
});
it('Full access still calls its existing base policy',()=>{
 const f=fixture('full');f.deny([{kind:'deny',class:'fixture',ruleId:'fixture',span:'fixture'}]);
 expect(d.decide(f.open(),baseCard).kind).toBe('card');
 expect(d.decide(f.open('other'),baseRun).kind).toBe('run');f.dispose();
});

it('No limits does not refuse ordinary work at the per-thread pending cap',()=>{
 const f=fixture();for(let n=0;n<40;n++)expect(d.decide(f.open('pending-'+n,{command:'eval "$OPAQUE"; echo ok'}),baseCard).kind).toBe('run');f.dispose();
});

for(const [command,wipe]of [['git push --force origin main',true],['rm -rf /w/.git',true],['printf x > ~/.ssh/id_ed25519',false]] as const)it(`level upgrade rechecks wipe-only evidence: ${command}`,async()=>{
 const f=fixture('ask'),handle=f.open('upgrade',{command,cwd:'/w'}),out=d.decide(handle,baseCard);
 expect(out.kind).toBe('card');if(out.kind!=='card')throw Error('missing initial Ask card');
 await d.presentApproval(out.ref,{title:'Action',subtitle:command});f.setLevel('unlimited');await d.onLevelChange('b');
 if(wipe){expect(f.respond).not.toHaveBeenCalled();expect(d.readApproval(out.ref.approvalId)?.why).toBe('wipe');}
 else expect(f.respond.mock.calls[0][1].behavior).toBe('allow');f.dispose();
});

it('No limits retains native snapshots past the capture cap and still cards a wipe',()=>{
 const f=fixture();
 try{
  for(let n=0;n<1540;n++)expect(d.decide(f.open('capture-'+n,{command:'printf ok'}),baseCard).kind).toBe('run');
  expect(d.decide(f.open('capture-tail-wipe',{command:'rm -rf ~'}),baseCard).kind).toBe('card');
 }finally{f.dispose();}
});
