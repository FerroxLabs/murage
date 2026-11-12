import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import ts from 'typescript';
import * as authority from './outside-authority.ts';
import * as highlevel from '../shared/highlevel.ts';
import * as phone from '../shared/phone-jobs-contract.ts';
import * as downloads from './download-registry.ts';
import * as marks from './email/external-marks.ts';
import * as dl from './outside-dl.ts';
import * as settle from './turn-settle.ts';
import { World, traces } from './testing/botcreate-world.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
useOutsideStoreFixture();
const imports: Record<string, unknown> = { './outside-authority.ts': authority, '../shared/highlevel.ts': highlevel, '../shared/phone-jobs-contract.ts': phone, './download-registry.ts': downloads, './email/external-marks.ts': marks, './outside-dl.ts': dl };
for (const trace of traces.filter(t => t.guard === 'mark-at-call')) it(`restoring mark-at-call goes RED through ${trace.id}`, () => {
  const source = readFileSync(new URL('./outside-own.ts', import.meta.url), 'utf8');
  const old = '"tool_result_read", "ask_bot", "delegate_bot"]);';
  expect(source.split(old)).toHaveLength(2);
  const js = ts.transpileModule(source.replace(old, '"tool_result_read"]);'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const mutant = {} as typeof import('./outside-own.ts');
  new Function('exports', 'require', js)(mutant, (name: string) => { if (!(name in imports)) throw new Error(name); return imports[name]; });
  const world = new World(settle, authority);
  const off = marks.observeOutsideMarks((thread, source) => world.L.mark(thread, source));
  const original = world.op.bind(world);
  world.op = (name, args) => { if (name === 'delegate' || name === 'ask') mutant.ownToolGate({ threadId: 'T', botId: 'chief', tool: name === 'ask' ? 'ask_bot' : 'delegate_bot', lane: true }); original(name, args); };
  try { const mismatches = world.run(trace); expect(mismatches.some(m => m.includes('want=active got=staged:outside'))).toBe(true); console.info(`KILLED mark-at-call by ${trace.id}: ${mismatches.join('; ')}`); }
  finally { off(); }
});
it('restoring status-poll mark-at-call goes RED for queued q123 wait_ms=0', () => {
  const source = readFileSync(new URL('./outside-own.ts', import.meta.url), 'utf8');
  const before = '"thread_read", "check_delegation", "wait_delegation", "tool_result_read"';
  expect(source.split(before)).toHaveLength(2);
  const js = ts.transpileModule(source.replace(before, '"thread_read", "tool_result_read"'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const mutant = {} as typeof import('./outside-own.ts');
  new Function('exports', 'require', js)(mutant, (name: string) => { if (!(name in imports)) throw new Error(name); return imports[name]; });
  const url = new URL('http://fixture/api/internal/delegations/q123?fromBotId=A&fromThreadId=T&wait_ms=0');
  mutant.ownToolGate({ threadId: 'T', botId: 'A', tool: mutant.ownToolOfRoute('GET', url.pathname), lane: true });
  expect(() => expect(marks.turnOutsideRead('T')).toBeNull()).toThrow();
  console.info('KILLED status-poll-mark-at-call');
});
