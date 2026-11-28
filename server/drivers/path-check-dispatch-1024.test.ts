// SPDX-License-Identifier: AGPL-3.0-or-later
// 1024 hygiene (S09/N9): the snapshot PATH check, through a real Claude turn dispatch (fake CLI), logs one value-free line only when
// a snapshot PATH entry is missing from the bot PATH; 0 missing is healthy and says nothing.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { admittedFixtureInstance } from '../testing/mcp-admission-fixture.ts';
import { ClaudeDriver } from './claude.ts';
import type { ProviderInstance } from '../contracts.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

const cli = fileURLToPath(new URL('../testing/fake-claude-cli.ts', import.meta.url));
let instance: ProviderInstance | undefined; let home = '';
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); if (home) removeTempDirSync(home); home = ''; });

async function turnLines(snapshotPath: string): Promise<string[]> {
  chmodSync(cli, 0o755); home = mkdtempSync(join(tmpdir(), 'murage-pathcheck-'));
  const config = join(home, '.claude'); mkdirSync(join(config, 'shell-snapshots'), { recursive: true });
  writeFileSync(join(config, 'shell-snapshots', 'snapshot-bash-1.sh'), `export PATH='${snapshotPath}'\n`);
  const lines: string[] = [];
  vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  instance = await admittedFixtureInstance(ClaudeDriver.create({ instanceId: 'fixture', displayName: 'Fixture', enabled: true, config: { cli, permissionMode: 'acceptEdits' }, environment: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_BG_ASKS: '0' } }));
  const recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn({ threadId: 'T', text: 'hello', cwd: home });
  await recorder.until(e => e.type === 'turn.completed' && e.turnId === turnId, 15_000);
  recorder.stop();
  return lines;
}

it('H3 a dispatched turn logs path-missing only when a snapshot PATH entry is missing from the bot PATH', async () => {
  const missing = await turnLines('/nonexistent-fixture-a:/nonexistent-fixture-b');
  expect(missing.filter(l => l.startsWith('claude exec path-missing'))).toEqual(['claude exec path-missing thread=T entries=2']);
  await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); removeTempDirSync(home);
  const none = await turnLines('');
  expect(none.filter(l => l.includes('path-missing'))).toEqual([]);
}, 40_000);
