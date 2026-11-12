// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPython } from './no-limits-python.ts';
import { readCode } from './no-limits-code.ts';
import { autoVerdict, type AutoContext } from './auto-approve.ts';
import { finalDecision, cleanRead, cutRead, observed } from '../shared/no-limits-decision.ts';
import { decideImageApproval } from './image-approval.ts';
const nl = {autoApprove:true, fullAccess:true, noLimits:true};
const owner: AutoContext = {fullAccessOrigin:'owner', ownerStarted:true, outsideRead:null, workFolder:'/w', commandCwd:'/w'};
const invalidTargets = ['1', 'f()', 'f()[0]', '1[0]', 'x.y[0]', 'x[0][0]', '[1]', '(x, 1)'];
describe('P1a validated targets', () => {
 for (const [index, target] of invalidTargets.entries()) for (const [position, statement] of Object.entries({
  loop: `for ${target} in []: pass`, assignment: `${target} = 0`, with: `with f() as ${target}: pass`,
  except: `try: pass\nexcept E as ${target}: pass`, import: `import h as ${target}`,
  del: `del ${target}`, augmented: `${target} += 1`,
 })) it(`${position}-${index}`, () => {
  const code=`import h as os\n${statement}\nos.remove('')`;
  expect(readPython(code).cut).toBe(true);
  const reads=readCode('python',code).reads;
  expect(reads.some(read=>read.state==='cut')).toBe(true);
  expect(reads.some(read=>read.state==='effect'&&read.cls==='word')).toBe(true);
 });
});
it('P1b owner cleanup and unreadable run', () => {
 for (const command of ['rm -rf build', 'rm -rf dist', 'rm -rf node_modules', 'rm -rf .cache/tmp', 'rm -rf /tmp/murage-fixture', 'cat ~/.ssh/id_rsa', "open('/w/README.md').read()"])
  expect(autoVerdict(nl, 'Bash', command, {...owner, commandText:command}).approve).not.toBeNull();
});
it('P1b unreadable plus wipe retains wipe', () => {
 const command = 'rm -rf /';
 expect(autoVerdict(nl, 'Bash', command, {...owner, commandText:command, inputTruncated:true})).toMatchObject({approve:null, rule:'delete-root'});
});
it('P2 image produces observations, never approval', () => {
 const candidate = decideImageApproval({level:nl, origin:'owner', ownerAudience:true, madeThisTurn:0, count:1});
 expect(candidate).not.toHaveProperty('ask', false);
 expect(candidate).toMatchObject({reads:[cleanRead('image-approval')], basis:'No limits'});
});
const fixture = JSON.parse(readFileSync(new URL('./testing/fixtures/no-limits-r13b-base.json', import.meta.url), 'utf8'));
const rcFixture = JSON.parse(readFileSync(new URL('./testing/fixtures/no-limits-r13b-rc-base.json', import.meta.url), 'utf8'));
const rcRows = new Map<string, any>(Object.entries(rcFixture.rows));
describe('P1b byte-for-byte base rows', () => {
 it('pins the actual 1.0.18 policy, before the routine waiver', () => {
  expect(fixture.commit).toBe('292df98d80a1c55db3e6f232166fc05162b632ab');
  expect(fixture.sourceSha256).toBe('7663ae7a06a84b14e6336ec1d03ccdeaecfeccee07c283cadb9624bde7ee352b');
 });
 for (const row of fixture.rows) it(row.id, () => {
  const actual = autoVerdict(row.bot, row.tool, row.summary, row.context);
  // Keep the immutable 1.0.18 archive, but compare unaffected policy to the
  // requested release candidate. The companion fixture was captured on be6823.
  const admitted = row.bot.noLimits && (row.context.fullAccessOrigin === 'owner'
    || row.context.fullAccessOrigin === 'routine' && row.context.routineLevel
    || row.context.routineLevel && !row.context.fullAccessOrigin
    || row.context.fullAccessOrigin === 'owner-channel' && row.bot.channelMessages !== false);
  if (admitted) {
    const input=row.context.call?.toolCall?.input;
    // A nonblank primary command is executed instead of the unused cmd alias.
    const wipe = row.summary === 'rm -rf /' || input?.cmd === 'rm -rf /' && !(typeof input.command==='string'&&input.command.trim());
    expect(actual.approve === null).toBe(wipe);
    if (wipe) expect(actual.rule).toBe('delete-root');
  } else if(row.bot.noLimits){
    // MAIN C2: unproven/guest raw No limits settings project to the existing Ask twin.
    const twin=fixture.rows.find((candidate:any)=>!candidate.bot.autoApprove&&candidate.tool===row.tool&&candidate.summary===row.summary&&JSON.stringify(candidate.context)===JSON.stringify(row.context));
    expect(twin,'RC Ask twin must exist').toBeDefined();expect(actual).toEqual(rcRows.get(twin.id));
  } else expect(actual).toEqual(rcRows.get(row.id));
 });
});
describe('r1.3b context by reader matrix', () => {
 const states = [cleanRead('matrix'), cutRead('unreadable'), cutRead('limit'), cutRead('budget'), cutRead('truncated'), cutRead('environment'), observed('code','word'), observed('code','root'), observed('code','home'), observed('code','system'), observed('code','disk'), observed('code','fork')];
 for (const kind of ['clean-owner','tainted-owner'] as const) for (const [i, read] of states.entries()) it(`${kind}-${i}`, () => {
  const decision = finalDecision([read], 'tool', {kind});
  // This legacy function is a conservative parser oracle; actor labels no longer grant permission.
  expect(decision.verdict).toBe(read.state === 'clean' ? 'run' : 'card');
 });
 for (const origin of ['routine','channel','webhook','delegated','other','Ask','Auto','Full access']) for (const [i, read] of states.entries()) it(`${origin}-${i}`, () => {
  const base = {approve:'base value', source:origin, extra:{marker:1}};
  expect(finalDecision([read], 'tool', {kind:'base', verdict:base})).toBe(base);
 });
});

it('P1b mandatory deny and wipe observations survive clean-owner cuts', () => {
 for (const read of [{state:'cut' as const,producer:'deny',mandatory:true as const}, {state:'effect' as const,producer:'wipe-list',cls:'word' as const,mandatory:true as const}, observed('wipe-list','root')])
  expect(finalDecision([cutRead('unreadable'),read], 'tool', {kind:'clean-owner'}).verdict).toBe('card');
});
it('P1b H12py stays conservative in the parser oracle; product permission is separate', async () => {
 const {readCode} = await import('./no-limits-code.ts');
 const lines=readFileSync(new URL('./testing/fixtures/no-limits-r12/judge_expected.tsv',import.meta.url),'utf8').split('\n');
 const [id, identity, mode, payload]=lines.find(line=>line.startsWith('H12py\t'))!.split('\t');
 expect(id).toBe('H12py');
 const reads=readCode(identity,JSON.parse(payload),mode).reads;
 expect(finalDecision(reads).verdict).toBe('card');
 expect(finalDecision(reads,'tool',{kind:'clean-owner'}).verdict).toBe('card');
});
