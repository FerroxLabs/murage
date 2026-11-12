// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';

const fixture = resolve('test/fixtures/smooth-triage/rig-32e3a501/smooth.mjs');
const patch = resolve(process.env.SMOOTH_TRIAGE_PATCH ?? 'evidence/smooth-triage/rig-32e3a501.patch');

it.each([
  { label: 'primary', primary: true, outcome: 'ok' },
  { label: 'secondary', primary: false, outcome: 'ok' },
  { label: 'product setup failure', primary: true, outcome: 'setup-failed' },
])('the pinned RC overlay measures five turns for $label', ({ primary, outcome }) => {
  const root = mkdtempSync(join(tmpdir(), 'smooth-rig-patch-'));
  try {
    const dir = join(root, 'scripts/smoothness'); mkdirSync(dir, { recursive: true });
    const original = readFileSync(fixture);
    // This is the full pinned rig source, not a rewritten scenario fixture.
    expect(createHash('sha256').update(original).digest('hex')).toBe('fdfaf611ccf5c08b4093f84483468faf21c2a614b998cdbc5fa43f154781055d');
    cpSync(fixture, join(dir, 'smooth.mjs'));
    execFileSync('git', ['apply', '--check', patch], { cwd: root });
    execFileSync('git', ['apply', patch], { cwd: root });
    const source = readFileSync(join(dir, 'smooth.mjs'), 'utf8');
    const helperImports = [...source.matchAll(/^import\s+\{\s*prepareLongThread\s*\}\s+from\s+["'][^"']+["'];/gm)].map(match => match[0]).join('\n');
    const start = source.indexOf('// S5 the longest real thread'), end = source.indexOf('// S6 deletion', start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const selected = primary ? 'primary' : 'secondary';
    // A normal Node module links the patch's exact import, then executes its
    // actual S5 scenario with inert boundaries. Missing imports fail at use.
    const probe = join(dir, 'scenario-probe.mjs');
    writeFileSync(probe, `${helperImports}
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root=${JSON.stringify(root)}, selected=${JSON.stringify(selected)}, outcome=${JSON.stringify(outcome)};
const calls=[], turns=[], scenarioBots=[];
const bot={id:'fixture-bot',threadId:'primary',modelSelection:{instanceId:'claude'},tasks:[{threadId:selected}]};
class DatabaseSync { prepare(){return {all:()=>[{t:selected,n:17}]};} close(){} }
const DATA=root, ENGINES='fake', realBots=[bot], WORKDIR=root;
const botFolder=()=>join(root,'desk');
const call=async(method,path,body)=>{calls.push({method,path,body});return {status:200,json:{task:{cwd:join(root,'desk')}}};};
const turn=async(_bot,thread)=>{turns.push(thread);return {outcome,failed:outcome!=='ok',resumed:outcome==='ok'&&turns.length>1,resets:0,wall:1,firstText:outcome==='ok'?1:null};};
const PROMPT=i=>'fixture-'+i, log=()=>{}, note=()=>{}, threadMessages=async()=>[], countSignatures=()=>({contextCard:0}), logFrom=()=>'', contextChangedIn=()=>[];
const summary=rows=>({failed:rows.filter(row=>row.failed).length});
let result;
const scenario=async(name,run)=>{if(name!=='longThread')throw Error('wrong scenario');result=await run({mark:0});};
${source.slice(start, end)}
process.stdout.write(JSON.stringify({result,calls,turns,scenarioBots}));
`);
    const measured = JSON.parse(execFileSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(measured.turns).toEqual(Array(5).fill(selected));
    expect(measured.calls.filter(call => call.method === 'PATCH' && call.path.includes('/tasks/'))).toHaveLength(1);
    expect(measured.calls.some(call => call.method === 'POST')).toBe(!primary);
    expect(measured.result.taskCwdPatch).toBe(200); expect(measured.result.resumed).toBe(outcome === 'ok' ? 4 : 0);
    expect(measured.result.failed).toBe(outcome === 'ok' ? 0 : 5);
    expect(measured.result.setupFailed).toBeUndefined(); expect(measured.result.error).toBeUndefined();
    expect(measured.scenarioBots).toEqual([{ id: bot.id, threadId: selected }]);
  } finally { safeWipeSync(root); }
});
