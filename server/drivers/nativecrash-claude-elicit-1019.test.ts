// SPDX-License-Identifier: AGPL-3.0-or-later
// RED-ONLY witness (cl-nativecrash): claude.ts writeControlResponse (:4031, elicitation answer). The binding is revoked while an
// elicitation card is open; the owner's answer is then fenced and swallowed by writeControlResponse (returns false). The call must
// not reject or escape, and the turn must end in a defined terminal refusal (the CLI waits on this reply with no bound of its own).
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../config.ts';
import { ClaudeDriver } from './claude.ts';
import { resetClaudeVersionGate } from './claude-guards.ts';
import { closeTurnLineage } from '../memory/lineage-write.ts';
import { recordEvents } from '../testing/events.ts';
import { fixtureMountTurn } from '../testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { expectDefinedRefusal, watchEscapes } from '../testing/nativecrash-harness.ts';
import type { ProviderInstance } from '../contracts.ts';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-claude-cli.ts');
const ELICIT = { subtype: 'elicitation', mcp_server_name: 'fixturesrv', display_name: 'Fixture', message: 'Run it?', mode: 'form', elicitation_id: 'el-1',
  requested_schema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Run it' } }, required: ['confirm'] }, property_order: ['confirm'] };
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_ELICIT; delete process.env.FAKE_CLAUDE_ELICIT_LOG; resetClaudeVersionGate();
  for (const c of cleanups.splice(0).reverse()) await c();
  await instance?.dispose().catch(() => {}); instance = undefined;
});

it('claude elicitation answer on a revoked turn neither rejects nor leaves the turn open (:4031)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'nc-clel-')); cleanups.push(() => removeTempDir(scratch));
  process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([ELICIT]); process.env.FAKE_CLAUDE_ELICIT_LOG = join(scratch, 'elicit.log');
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await ClaudeDriver.create({ instanceId: 'nc-clel', displayName: 'Claude', environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: 'bypassPermissions' } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  // the harness fixture owns the binding; revoking = retiring its open lineage turn (isCurrent stays private to the fixture)
  const input = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'nc-clel', text: 'go' });
  const sent = await instance.adapter.sendTurn(input);
  const card = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as unknown as { requestId: string };
  closeTurnLineage(input.releaseBinding!.turn);
  let threw: unknown;
  await instance.adapter.respondToRequest('nc-clel', card.requestId, { behavior: 'answer', answers: [{ id: 'confirm', selected: ['Yes'] }] }).catch(error => { threw = error; });
  expect.soft(threw, 'respondToRequest rejected').toBeUndefined();
  await expectDefinedRefusal(recorder, watch, sent.turnId);
});
