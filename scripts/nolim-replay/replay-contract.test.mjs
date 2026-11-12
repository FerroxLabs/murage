import { expect, it, vi } from 'vitest';
import { replayActor, parityRequired, replayDecide, availability } from './replay-decide.mjs';
import { checkReplay, digest } from './release-check.mjs';
const label = { actor: 'owner-routine', via: 'routine-wake', kind: 'none', independent: true };
it('J1 provenance comes only from the independent actor column', () => {
 const row = { level: 'unlimited', label, cardClass: { origin: 'webhook', unattended: 1 } };
 expect(replayActor(row).kind).toBe('owner-routine'); expect(parityRequired(row)).toBe(false);
 expect(parityRequired({ ...row, level: 'full' })).toBe(true);
 expect(replayActor({ ...row, label: { ...label, actor: 'other' } }).kind).toBe('other');
 expect(() => replayActor({ ...row, label: undefined })).toThrow('ACTOR_LABEL_UNAVAILABLE');
});
it('J1 fixture registration, decision and presentation use the production API in order', async () => {
 const row = { key: { threadId: 't', requestId: 'r', botId: 'b', turnId: 'u' }, tool: 'shell', fullToolInput: { command: 'echo fixture' }, denySnapshot: { rules: [] }, levelFlags: { noLimits: true }, label };
 const ref = { approvalId: 'a' }, handle = {}, outcome = { kind: 'card', ref }; const calls = [];
 const production = { openRequest: vi.fn(source => { expect(source.kind).toBe('replay'); expect(source.label.actor).toBe('owner-routine'); expect(Object.isFrozen(source.row.fullToolInput)).toBe(true); calls.push('open'); return handle; }),
  decide: vi.fn(h => { expect(h).toBe(handle); calls.push('decide'); return outcome; }),
  presentApproval: vi.fn(async r => { expect(r).toBe(ref); calls.push('present'); }), baseVerdict: vi.fn() };
 expect(await replayDecide(row, production)).toBe(outcome); expect(calls).toEqual(['open','decide','present']);
 await expect(replayDecide({ ...row, fullToolInput: null }, production)).rejects.toThrow('FULL_INPUT_UNAVAILABLE');
});
it('J1 unavailable stays unavailable with a live-shape requirement', () => {
 expect(availability({ tool: 'shell', summary: 'echo truncated...' })).toMatchObject({ status: 'unavailable', shape: 'shell' });
 expect(availability({ tool: 'shell', fullToolInput: { command: 'echo x' } })).toMatchObject({ status: 'available' });
});
it('J1 blind labels require both columns and the committed hash', () => {
 const candidateSha = 'a'.repeat(40);
 const rows = Array.from({ length: 140 }, (_, i) => ({ key: { threadId: 't', requestId: String(i) }, fullToolInput: { command: 'echo fixture' }, level: 'unlimited' }));
 const labels = rows.map(r => ({ key: r.key, kind: 'none', actor: 'owner', inputHash: digest(r.fullToolInput), independent: true }));
 const labelBytes = JSON.stringify(labels);
 const results = rows.map(r => ({ key: r.key, candidateSha, status: 'judged', kind:'run', cards: 0, parityDigest: 'base' }));
 const args = { release:false, candidateSha, rows, labels, labelBytes, committedLabelHash: digest(labelBytes), results, baseline: results.map(r => ({ ...r, sourceSha: '292df98d80a1c55db3e6f232166fc05162b632ab' })) };
 expect(checkReplay(args).verdict).toBe('PASS');
 expect(checkReplay({ ...args, results: [{ ...results[0], questions: 1, why: 'question' }, ...results.slice(1)] }).verdict).toBe('FAIL');
 for (const patch of [{ status: 'unavailable' }, { candidateSha: 'b'.repeat(40) }, { cards: 1 }]) expect(checkReplay({ ...args, results: [{ ...results[0], ...patch }, ...results.slice(1)] }).verdict).toBe('FAIL');
 const bad = labels.map(({ actor, ...rest }) => rest); const bytes = JSON.stringify(bad);
 expect(checkReplay({ ...args, labels: bad, labelBytes: bytes, committedLabelHash: digest(bytes) }).verdict).toBe('FAIL');
});
it('J1 question labels require one question record and zero permission cards', () => {
 const candidateSha = 'a'.repeat(40);
 const rows = Array.from({ length: 140 }, (_, i) => ({ key: { threadId: 't', requestId: String(i) }, fullToolInput: {}, level: 'unlimited' }));
 const labels = rows.map(r => ({ key:r.key, kind:'question', actor:'owner', inputHash:digest(r.fullToolInput), independent:true }));
 const labelBytes = JSON.stringify(labels);
 const results = rows.map(r => ({ key:r.key, candidateSha, status:'judged', cards:0, questions:1, why:'question' }));
 const args = { release:false, candidateSha, rows, labels, labelBytes, committedLabelHash:digest(labelBytes), results, baseline:results.map(r => ({ ...r, sourceSha:'292df98d80a1c55db3e6f232166fc05162b632ab' })) };
 expect(checkReplay(args).verdict).toBe('PASS');
 for (const patch of [{ questions:0 }, { questions:2 }, { why:undefined }, { cards:1 }]) {
  expect(checkReplay({ ...args, results:[{ ...results[0], ...patch }, ...results.slice(1)] }).verdict).toBe('FAIL');
 }
});

it.each([
 {card:{subtitle:'x…[truncated, 42 characters more]'}},
 {fullToolInput:{command:'echo «redacted 20 chars»'}},
 {tool:'browser_open'},
])('BLOCK6 persisted markers and missing historical deny context are unavailable', patch=>{
 expect(availability({tool:'shell',fullToolInput:{command:'echo fixture'},...patch}).status).toBe('unavailable');
});
it('BLOCK6 unavailable rows require a witnessed same-candidate J3 shape',()=>{
 const candidateSha='a'.repeat(40);
 const rows=Array.from({length:140},(_,i)=>({key:{threadId:'t',requestId:String(i)},tool:'shell',fullToolInput:null,level:'unlimited'}));
 const labels=rows.map(r=>({key:r.key,kind:'none',actor:'owner',independent:true,inputHash:digest(null)}));
 const labelBytes=JSON.stringify(labels);
 const results=rows.map(r=>({key:r.key,candidateSha,status:'unavailable',reason:'unavailable:input',requiredLiveRow:'unavailable-shell-missing-input'}));
 const baseline=rows.map(r=>({key:r.key,sourceSha:'292df98d80a1c55db3e6f232166fc05162b632ab',status:'unavailable'}));
 const args={release:false,candidateSha,rows,labels,labelBytes,committedLabelHash:digest(labelBytes),results,baseline};
 expect(checkReplay(args).verdict).toBe('FAIL');
 expect(checkReplay({...args,liveRows:[{id:'unavailable-shell-missing-input',candidateSha,verdict:'PASS',actionProven:true}]}).verdict).toBe('PASS');
 expect(checkReplay({...args,liveRows:[{id:'unavailable-shell-missing-input',candidateSha:'b'.repeat(40),verdict:'PASS',actionProven:true}]}).verdict).toBe('FAIL');
});

it('BLOCK6 a masked executable subtitle remains unavailable even with supplied full input',()=>{
 expect(availability({tool:'shell',fullToolInput:{command:'echo fixture'},card:{subtitle:'bash «redacted 42 chars»'}})).toMatchObject({status:'unavailable',reason:'unavailable:input'});
});

it('BLOCK6 release runner retains the independently labeled context-unavailable reason',async()=>{
 const {replayCards}=await import('./release-runner.mjs');
 const key={threadId:'t',requestId:'r',botId:'b',turnId:'u'};
 const labels=[{key,actor:'owner',kind:'needs-context',independent:true}];
 const result=await replayCards({rows:[{key,tool:'shell',fullToolInput:{command:'echo fixture'}}],labels,labelBytes:JSON.stringify(labels),committedLabelHash:'a'.repeat(64),candidateSha:'b'.repeat(40),baseline:[],production:{}});
 expect(result.results[0]).toMatchObject({status:'unavailable',reason:'unavailable:context',requiredLiveRow:'unavailable-shell-context'});
});

it('BLOCK6 the v2 exported boundedToolInput markers are authoritative',()=>{
 expect(availability({tool:'shell',fullToolInput:{command:'echo fixture'},boundedToolInput:'{"command":"echo fixture"}\n[truncated, 20 bytes more]'}).status).toBe('unavailable');
});

it('BLOCK6 cut commands, long heredocs and redacted executables cannot share an incidental J3 witness',()=>{
 const row={tool:'shell',fullToolInput:{command:'echo fixture'}};
 const requirements=[
  availability({...row,card:{subtitle:'echo x…[truncated, 2 characters more]'}}).requiredLiveRow,
  availability({...row,card:{subtitle:'cat <<EOF\nx…[truncated, 2 characters more]'}}).requiredLiveRow,
  availability({...row,card:{subtitle:'echo «redacted 2 chars»'}}).requiredLiveRow,
 ];
 expect(requirements).toEqual(['unavailable-shell-truncated','unavailable-shell-long-heredoc','unavailable-shell-redacted']);
});

it('release runner preserves feature-off proof and rejects a candidate that runs or cards instead',async()=>{
 const {replayCards}=await import('./release-runner.mjs');const candidateSha='a'.repeat(40);
 const rows=Array.from({length:140},(_,i)=>({key:{threadId:'t',requestId:String(i),botId:'b',turnId:'u'},tool:'shell',fullToolInput:{command:'printf fixture'},denySnapshot:{rules:[]},levelFlags:{noLimits:true},level:'unlimited'}));
 const labels=rows.map(row=>({key:row.key,actor:'owner',kind:'feature-off',feature:'browser',independent:true,inputHash:digest(row.fullToolInput)}));
 const labelBytes=JSON.stringify(labels),baseline=rows.map(row=>({key:row.key,status:'judged',sourceSha:'292df98d80a1c55db3e6f232166fc05162b632ab'}));
 const off={kind:'off',featureOff:{feature:'browser',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Browser control is off. Turn it on in Settings > Browser.']}};
 const check=outcome=>replayCards({rows,labels,labelBytes,committedLabelHash:digest(labelBytes),candidateSha,baseline,release:false,
  production:{openRequest:()=>({}),decide:()=>outcome,baseVerdict:()=>({}),baseResultFor:()=>({}),canonicalBase:x=>x,readRecord:()=>({why:'deny',evidence:[]}),presentApproval:()=>{}}});
 expect((await check(off)).verdict).toBe('PASS');
 for(const outcome of [{kind:'run'},{kind:'card',ref:{approvalId:'a'}},{kind:'off'}, {...off,holds:1},{...off,featureOff:{...off.featureOff,actionExecuted:true}}])expect((await check(outcome)).verdict).toBe('FAIL');
});
