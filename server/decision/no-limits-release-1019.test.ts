// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane C: inspection-to-delivery races. All disk changes stay in this fixture;
// protected paths are classifier inputs only and are never written/executed.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '../testing/cleanup.ts';
import { fixture, d, baseRun, snapshotRegistration } from './fixture.ts';
import type { Registration } from './types.ts';

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'nlsym-release-')); mkdirSync(join(scratch, 'out')); });
afterEach(() => removeTempDir(scratch));
const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const nativeRows = [
  ['write', { path: 'out/notes', content: 'hello' }],
  ['edit', { file_path: 'out/notes', old_string: 'a', new_string: 'b' }],
  ['delete', { path: 'out/notes' }],
  ['edit', { paths: ['out/one', 'out/two'], removed: ['out/one'] }],
  ['apply_patch', { input: patch('*** Add File: out/notes', '+hello') }],
  ['apply_patch', { input: patch('*** Update File: out/one', '*** Move to: out/two', '@@', '-a', '+b') }],
] as const;
// MAIN 2026-11-12 C1 supersedes C7 non-wipe permission holds. The
// physical destination changes remain fixtures, with actual fake delivery checked.
function pendingProtected(f: ReturnType<typeof fixture>) {
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
  expect(d.openApprovals('t')).toEqual([]);
}

describe('G-NL release: real registration, fresh exact input, no allow transport', () => {
  it.each([false, true])('R10a ordinary shell changed=%s', async changed => {
    const f = fixture(), target = join(scratch, 'notes'); writeFileSync(target, 'ordinary');
    const h = f.open('shell', { command: 'printf x > notes', cwd: scratch });
    expect(d.decide(h, baseRun)).toEqual({ kind: 'run' });
    if (changed) { unlinkSync(target); symlinkSync('/etc/hosts', target); }
    await d.deliverRequest(h);
    if (changed) pendingProtected(f); else expect(f.respond).toHaveBeenCalledWith(expect.anything(), { behavior: 'allow' }, expect.anything());
  });

  it.each(nativeRows.flatMap(([tool, input]) => [false, true].map(changed => ({tool, input, changed}))))('R10b/e exact $tool parent changed=$changed $input', async ({tool, input, changed}) => {
    const f = fixture();
    const h = f.open('native', {}, { tool, toolCall: { name: tool, input: { ...input, cwd: scratch } } });
    // MAIN RULING NARROW-WIPE: ordinary files and patch moves do not wipe a whole root.
    expect(d.decide(h, baseRun).kind).toBe('run');
    if (changed) { await removeTempDir(join(scratch, 'out')); symlinkSync('/etc', join(scratch, 'out')); }
    await d.deliverRequest(h);
    if (changed) pendingProtected(f); else expect(f.respond).toHaveBeenCalledWith(expect.anything(), { behavior: 'allow' }, expect.anything());
  });

  it('R10e final path after 256 ordinary patch paths is retained at release', async () => {
    const f = fixture();
    const input = { input: patch(...Array.from({length: 300}, (_, i) => [`*** Add File: out/file-${i}`, '+x']).flat()), cwd: scratch };
    const h = f.open('many', {}, { tool: 'apply_patch', toolCall: {name: 'apply_patch', input} });
    expect(d.decide(h, baseRun)).toEqual({kind: 'run'});
    symlinkSync('/etc/hosts', join(scratch, 'out', 'file-299'));
    await d.deliverRequest(h); pendingProtected(f);
  });

  it.each([false, true])('E32g effective cp child refreshed changed=%s', async changed => {
    const f=fixture(); writeFileSync(join(scratch,'blob'),'ordinary');
    writeFileSync(join(scratch,'out','blob'),'ordinary');
    const h=f.open('child',{command:'cp blob out',cwd:scratch});
    expect(d.decide(h,baseRun)).toEqual({kind:'run'});
    if(changed){unlinkSync(join(scratch,'out','blob'));symlinkSync('/etc/hosts',join(scratch,'out','blob'));}
    await d.deliverRequest(h);
    if(changed)pendingProtected(f);else expect(f.respond).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('C33h physical cwd refreshed changed=%s', async changed => {
    const f=fixture(); symlinkSync(join(scratch,'out'),join(scratch,'e'));
    const h=f.open('cwd',{command:'cd -P e; printf x > hosts',cwd:scratch});
    expect(d.decide(h,baseRun)).toEqual({kind:'run'});
    if(changed){unlinkSync(join(scratch,'e'));symlinkSync('/etc',join(scratch,'e'));}
    await d.deliverRequest(h);
    if(changed)pendingProtected(f);else expect(f.respond).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('R10h service exact input parent changed=%s', async changed => {
    const f = fixture();
    const h = d.openRequest({kind:'service', service:'email', claim:f.claim, call:{tool:'write_file', input:{path:join(scratch,'out','notes'),content:'x'}}});
    expect(d.decide(h, baseRun)).toEqual({kind:'run'});
    if (changed) { await removeTempDir(join(scratch, 'out')); symlinkSync('/etc', join(scratch, 'out')); }
    const execute = vi.fn(async () => 'fake-only');
    const result = await d.executeService(h, execute);
    { expect(result).toEqual({kind:'executed', value:'fake-only'}); expect(execute).toHaveBeenCalledTimes(1); }
  });

  it.each([false, true])('R10h synchronous service parent changed=%s', async changed => {
    const f=fixture();
    const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'write_file',input:{path:join(scratch,'out','notes'),content:'x'}}});
    expect(d.decide(h,baseRun)).toEqual({kind:'run'});
    if(changed){await removeTempDir(join(scratch,'out'));symlinkSync('/etc',join(scratch,'out'));}
    const execute=vi.fn(()=> 'fake-only');
    const result=d.executeServiceSync(h,execute);
    {expect(result).toEqual({kind:'executed',value:'fake-only'});expect(execute).toHaveBeenCalledTimes(1);}
  });

  it('R10h service disk changes after scheduling and before the actual callback',async()=>{
    const f=fixture();
    const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'write_file',input:{path:join(scratch,'out','notes'),content:'x'}}});
    expect(d.decide(h,baseRun)).toEqual({kind:'run'});
    const execute=vi.fn(async()=> 'fake-only');
    const work=d.executeService(h,execute);
    symlinkSync('/etc/hosts',join(scratch,'out','notes'));
    expect((await work).kind).toBe('executed');expect(execute).toHaveBeenCalledTimes(1);
  });

  // Protected-only cards and rewritten protected approval variants were
  // retired by MAIN C1: no initial card exists at No limits. Their wipe twins
  // and stale wipe receipts are exercised in no-limits-merge-rulings.test.ts.
  it.each([false,true])('H12b named protected inode registry refreshed changed=%s',async changed=>{
    // Fixture repair: setup.ts now uses worker/home. This row explicitly
    // owns its historical named-home premise inside its existing scratch dir;
    // keep the original isolation and inode assertions unchanged.
    const previous={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE};
    const fixtureHome=mkdtempSync(join(tmpdir(),'murage-test-home-'));
    process.env.HOME=fixtureHome;process.env.USERPROFILE=fixtureHome;
    const f=fixture(), target=join(scratch,'out','notes'), named=join(homedir(),'.zshrc');
    // This fixture owns this temporary home; no account home/registry is modified.
    expect(homedir()).toContain('murage-test-home-');
    writeFileSync(target,'ordinary'); writeFileSync(named,'separate fixture inode');
    onTestFinished(async()=>{
      if(existsSync(named))unlinkSync(named);
      for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      await removeTempDir(fixtureHome);
    });
    const h=f.open('inode',{}, {tool:'write_file',toolCall:{name:'write_file',input:{path:target,content:'fake-only'}}});
    expect(d.decide(h,baseRun)).toEqual({kind:'run'});
    if(changed){unlinkSync(named);linkSync(target,named);}
    await d.deliverRequest(h);
    if(changed)pendingProtected(f);else expect(f.respond).toHaveBeenCalledTimes(1);
  });
});

describe('F09 lane C legacy Full access byte snapshots', () => {
  const cases = [
    ['shell', {command:'printf x > /fixture/out/notes', cwd:'/fixture'}],
    ...nativeRows.map(([tool, input]) => [tool, {...input, cwd:'/fixture'}] as const),
    ['edit', {paths:['/etc/hosts','/fixture/notes'], removed:['/fixture/notes'], cwd:'/fixture'}],
  ] as const;
  it.each(cases.map(([tool,input], i) => ({tool,input,i})))('F09 full $i $tool complete serialized registration and deny-source inputs', ({tool,input,i}) => {
    const f = fixture('full'), seen: unknown[] = [];
    d.installDenySources({revision:()=>['1'],resolve:(botId, targets)=>{seen.push({botId, targets});return [];}});
    const h = f.open(`full-${i}`, {}, {tool, toolCall:{name:tool,input}});
    let registration: Registration | undefined;
    expect(d.decide(h, r => {registration=r;return baseRun();})).toEqual({kind:'run'});
    expect(JSON.stringify({registration:snapshotRegistration(registration), denySources:seen})).toMatchSnapshot();
    f.dispose();
  });
});

it('a literal root wipe still cards at release-fixture No limits',()=>{
 const f=fixture();
 try{expect(d.decide(f.open('root-control',{command:'rm -rf /',cwd:scratch}),baseRun).kind).toBe('card');}
 finally{f.dispose();}
});
