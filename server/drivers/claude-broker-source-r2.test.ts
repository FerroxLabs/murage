// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeDriver } from './claude.ts';
import { RuntimeAudienceCollector } from '../harness/audience-collector.ts';
import { recordAdmittedEvents } from '../testing/admitted-events.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { ensureDirs } from '../config.ts';
import type { ProviderInstance, RuntimeEvent, SourceContext } from '../contracts.ts';
vi.mock('node:child_process', async original => (await import('../testing/exec-check-spy.ts')).withExecCheckSpy(await original()));
useOutsideStoreFixture();
let instance: ProviderInstance | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; delete process.env.FAKE_CLAUDE_PERM_TOOL; delete process.env.FAKE_CLAUDE_PERM_INPUT; });

it('a reused permission broker publishes each ask and resolution with that live turn source', async () => {
  ensureDirs();
  const cli = fileURLToPath(new URL('../testing/fake-claude-cli.ts', import.meta.url));
  chmodSync(cli, 0o755);
  process.env.FAKE_CLAUDE_PERM_TOOL = 'Bash';
  // The fake reports a permission decision and never executes this command.
  process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command: 'printf fixture > /etc/source-fixture', cwd: '/tmp' });
  instance = await ClaudeDriver.create({ instanceId: 'broker-source', displayName: 'Fixture', environment: {}, enabled: true,
    config: { cli, permissionMode: 'acceptEdits' } });
  const collector = new RuntimeAudienceCollector(), attachment = collector.attach('broker-source');
  const events: { event: RuntimeEvent; source: SourceContext | undefined }[] = [];
  const off = instance.adapter.onEvent((event, source) => {
    events.push({ event, source });
    if (event.type === 'request.opened') void instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: 'deny' });
  });
  const recorder = recordAdmittedEvents(instance.adapter), cwd = fixtureBotFolder(), threadId = 'broker-source-turn';
  try {
    for (let turn = 0; turn < 2; turn++) {
      const sourceContext = collector.source(collector.admitNewTurn({ attachment, instanceId: 'broker-source', threadId }));
      const sent = await instance.adapter.sendTurn({ threadId, cwd, text: '__fixture_permission_tool__', routeAsks: true, sourceContext });
      await recorder.until(event => event.type === 'turn.completed' && event.turnId === sent.turnId, 15_000);
      const asks = events.filter(row => row.event.turnId === sent.turnId && row.event.type === 'request.opened');
      const resolutions = events.filter(row => row.event.turnId === sent.turnId && row.event.type === 'request.resolved');
      expect(asks).toHaveLength(1); expect(resolutions).toHaveLength(1);
      expect(asks[0].source).toBe(sourceContext); expect(resolutions[0].source).toBe(sourceContext);
    }
  } finally { off(); recorder.stop(); }
}, 45_000);
