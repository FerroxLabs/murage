import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
function corpus() {
  return Array.from({ length: 257 }, (_, i) => ({ id: `logged-${i}`, source: 'redacted-real-log', tool: 'Bash',
    fullToolInput: { command: 'printf fixture' }, label: { independent: true, kind: 'none', actor: 'owner', origin: 'desktop' } }));
}
const controls = [
  { id: 'control-home', tool: 'Bash', fullToolInput: { command: 'rm -rf ~' }, label: { independent: true, kind: 'wipe', actor: 'owner', origin: 'desktop' } },
  { id: 'control-root', tool: 'Bash', fullToolInput: { command: 'rm -rf /' }, label: { independent: true, kind: 'wipe', actor: 'owner', origin: 'desktop' } },
  { id: 'control-disk', tool: 'Bash', fullToolInput: { command: 'mkfs.ext4 /dev/sda' }, label: { independent: true, kind: 'wipe', actor: 'owner', origin: 'desktop' } },
];
// A fake boundary is solely for qualifying the gate. It cannot produce a
// release receipt; real replay imports the candidate production adapter.
const fake = async row => ({ kind: row.id.startsWith('control-') ? 'card' : 'run', why: row.id.startsWith('control-') ? 'wipe' : undefined });
test('all 257 real-log rows and three wipe controls are mandatory', async () => {
  const { replayRuling } = await import('./ruling.mjs');
  const rows = corpus(); const r = await replayRuling({ rows, controls, decide: fake });
  assert.equal(r.verdict, 'PASS'); assert.equal(r.rows, 257); assert.equal(r.controls.pass, 3);
  for (const patch of [{ rows: rows.slice(1) }, { rows: [] }, { controls: [] }, { rows: [...rows.slice(0, 256), rows[0]] }]) {
    assert.equal((await replayRuling({ rows, controls, decide: fake, ...patch })).verdict, 'FAIL');
  }
});
test('one non-wipe card, refusal, silent deny or missing input kills replay', async () => {
  const { replayRuling } = await import('./ruling.mjs');
  for (const outcome of [{ kind: 'card', why: 'deny' }, { kind: 'card', why: 'wipe' }, { kind: 'refuse' }, { kind: 'deny' }, { kind: 'hold' }, {}]) {
    const r = await replayRuling({ rows: corpus(), controls, decide: row => row.id === 'logged-0' ? outcome : fake(row) });
    assert.equal(r.verdict, 'FAIL', JSON.stringify(outcome));
  }
  for (const patch of [{ fullToolInput: null }, { truncated: true }, { redacted: true }, { label: { independent: false } }]) {
    const rows = corpus(); rows[0] = { ...rows[0], ...patch };
    assert.equal((await replayRuling({ rows, controls, decide: fake })).verdict, 'FAIL');
  }
});
test('every positive wipe control must actually card, not refuse or run', async () => {
  const { replayRuling } = await import('./ruling.mjs');
  for (const outcome of [{ kind: 'run' }, { kind: 'refuse' }, { kind: 'card', why: 'deny' }]) {
    assert.equal((await replayRuling({ rows: corpus(), controls, decide: row => row.id === 'control-root' ? outcome : fake(row) })).verdict, 'FAIL');
  }
});
test('replay receipts bind exact corpus bytes and never call a missing corpus a pass', async () => {
  const { admitCorpus } = await import('./ruling.mjs');
  const bytes = Buffer.from(corpus().map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(admitCorpus(bytes, sha(bytes)).length, 257);
  for (const [body, hash] of [[bytes, '0'.repeat(64)], [Buffer.from(''), sha('')]]) assert.throws(() => admitCorpus(body, hash));
  const rows = corpus(); rows[0].source = 'synthetic';
  const synthetic = Buffer.from(rows.map(r => JSON.stringify(r)).join('\n'));
  assert.throws(() => admitCorpus(synthetic, sha(synthetic)), /real-log/);
});

test('stored permission rules run for every eligible actor; feature switches remain off with one line', async () => {
 const {replayRuling}=await import('./ruling.mjs');const rows=corpus();
 const check=first=>replayRuling({rows,controls,decide:row=>row.id==='logged-0'?first:fake(row)});
 const refuse={kind:'refuse',ownerRefusal:{source:'deny-browser-never',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Browser access is off.']}};
 for(const kind of ['owner-deny','permission-rule'])for(const actor of ['owner','owner-routine','webhook','owner-channel','owner-phone','guest','non-owner']){
  rows[0].label={independent:true,kind,actor,denySource:'deny-browser-never',permissionExplicit:true,origin:'channel-dm'};
  rows[0].denySnapshot={evidence:[{kind:'deny',ruleId:'deny-browser-never',class:'stored',span:'printf fixture'}]};
  const witness={source:'deny-browser-never',ruleInstalled:true,actionExecuted:true};
  assert.equal((await check({kind:'run',permissionRuleWitness:witness})).verdict,'PASS',kind+actor);
  for(const patch of [{denySnapshot:undefined},{denySnapshot:{evidence:[]}},{denySnapshot:{evidence:[{kind:'deny',ruleId:'wrong',class:'stored',span:'printf fixture'}]}}]){const saved=rows[0];rows[0]={...saved,...patch};assert.equal((await check({kind:'run',permissionRuleWitness:witness})).verdict,'FAIL');rows[0]=saved;}
  for(const permissionRuleWitness of [undefined,{...witness,source:'wrong'},{...witness,ruleInstalled:false},{...witness,actionExecuted:false}])assert.equal((await check({kind:'run',permissionRuleWitness})).verdict,'FAIL');
  for(const outcome of [refuse,{kind:'card',why:'deny'},{kind:'hold'},{kind:'deny'},{kind:'run',messages:[{kind:'options',card:{setup:true}}]},{kind:'run',actionExecuted:false},{kind:'run',refusals:1},{kind:'run',cards:1},{}])assert.equal((await check(outcome)).verdict,'FAIL',JSON.stringify(outcome));
 }
 rows[0].label={independent:true,kind:'feature-off',actor:'owner',feature:'browser'};
 const off={kind:'off',featureOff:{feature:'browser',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Browser control is off. Turn it on in Settings > Browser.']}};
 assert.equal((await check(off)).verdict,'PASS');
 for(const mutant of [{kind:'run'},{kind:'card',why:'deny'},refuse,{kind:'off'},
  {...off,featureOff:{...off.featureOff,actionExecuted:true}}, {...off,cards:1}, {...off,holds:1},
  {...off,featureOff:{...off.featureOff,ownerLines:['Browser is off.']}}])assert.equal((await check(mutant)).verdict,'FAIL',JSON.stringify(mutant));
});
