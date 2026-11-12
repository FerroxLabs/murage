// SPDX-License-Identifier: AGPL-3.0-or-later
// Real driver launch with a fake CLI and an isolated home; no provider calls.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDirs } from '../config.ts';
import type { ProviderInstance } from '../contracts.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { recordEvents, type EventRecorder } from '../testing/events.ts';
import { ClaudeDriver, CLAUDE_SIGNIN_SETTINGS_KEYS, CLAUDE_SIGNIN_TOOL, claudeSigninAnswers, claudeSigninScope } from './claude.ts';

vi.mock('node:child_process', async original => (await import('../testing/exec-check-spy.ts')).withExecCheckSpy(await original()));
const cli = fileURLToPath(new URL('../testing/fake-claude-cli.ts', import.meta.url));
let root: string, instance: ProviderInstance | undefined, recorder: EventRecorder | undefined;
beforeEach(() => {
  ensureDirs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-no-limits-settings-')));
  chmodSync(cli, 0o755);
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  delete process.env.FAKE_CLAUDE_DUMP;
  removeTempDirSync(root);
});

for (const saved of [undefined, false, true]) for (const unattended of [false, true]) {
  it(`No limits launches without a sign-in settings question: saved=${saved}, unattended=${unattended}`, async () => {
    const project = join(root, '.claude', 'settings.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(project, JSON.stringify({
      ...Object.fromEntries(CLAUDE_SIGNIN_SETTINGS_KEYS.map(key => [key, key === 'modelOverrides' ? { fixture: 'fixture-model' } : '/fixture/not-executed'])),
      env: { ANTHROPIC_MODEL: 'fixture-repository-model' },
    }));
    const scope = claudeSigninScope(process.platform, [{ path: project, source: 'project' }]);
    if (saved !== undefined) claudeSigninAnswers.remember(scope, saved);
    const dump = join(root, 'launch.json');
    process.env.FAKE_CLAUDE_DUMP = dump;
    instance = await ClaudeDriver.create({ instanceId: 'p', displayName: 'Fixture', enabled: true, environment: {}, config: { cli, permissionMode: 'acceptEdits' } });
    recorder = recordEvents(instance.adapter);
    // Release a regressed hold so RED is a direct assertion, never a timeout.
    const off = instance.adapter.onEvent(event => {
      if (event.type === 'request.opened' && event.tool === CLAUDE_SIGNIN_TOOL) {
        void instance!.adapter.respondToRequest('t', event.requestId!, { behavior: 'deny' });
      }
    });
    try {
      await instance.adapter.sendTurn({ threadId: 't', cwd: root, text: 'fixture-only',
        permissionNow: () => ({ noLimits: true, stopLine: true, routeAsks: true }),
        ...(unattended ? { background: true, unattendedAskNote: true } : {}),
      });
      const done = await recorder.until(event => event.type === 'turn.completed');
      expect(recorder.events.filter(event => event.type === 'request.opened')).toEqual([]);
      expect(done).toMatchObject({ ok: true });
      const launch = JSON.parse(readFileSync(dump, 'utf8')) as { settingsFiles: Array<{ env?: Record<string, string> }> };
      const overlay = launch.settingsFiles.find(settings => settings?.env && 'CLAUDE_CODE_PLUGIN_DIRS' in settings.env)!;
      expect(overlay.env).not.toHaveProperty('ANTHROPIC_MODEL');
      // Automatic No limits permission must not rewrite the owner's saved answer.
      expect(claudeSigninAnswers.recall(scope)).toBe(saved);
    } finally { off(); }
  });
}

it('current Ask permission keeps a saved sign-in denial despite a stale No limits launch hint', async () => {
  const project = join(root, '.claude', 'settings.json');
  mkdirSync(join(root, '.claude'));
  writeFileSync(project, JSON.stringify({ apiKeyHelper: '/fixture/not-executed' }));
  claudeSigninAnswers.remember(claudeSigninScope(process.platform, [{ path: project, source: 'project' }]), false);
  instance = await ClaudeDriver.create({ instanceId: 'p', displayName: 'Fixture', enabled: true, environment: {}, config: { cli, permissionMode: 'acceptEdits' } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: 't', cwd: root, text: 'fixture-only', noLimits: true,
    permissionNow: () => ({ noLimits: undefined, stopLine: undefined, routeAsks: true }),
  });
  expect(await recorder.until(event => event.type === 'turn.completed')).toMatchObject({ ok: false });
  expect(recorder.events.filter(event => event.type === 'request.opened')).toEqual([]);
});

for (const noLimits of [false, true]) for (const tool of ['Read', 'Bash']) {
  it(`saved tool deny reaches native argv only below No limits: noLimits=${noLimits}, tool=${tool}`, async () => {
    const dump = join(root, 'native-posture.json');
    process.env.FAKE_CLAUDE_DUMP = dump;
    instance = await ClaudeDriver.create({ instanceId: 'p', displayName: 'Fixture', enabled: true, environment: {},
      config: { cli, permissionMode: 'acceptEdits', disallowedTools: [tool] },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: 't', cwd: root, text: 'fixture-only', noLimits: !noLimits ? true : undefined,
      permissionNow: () => ({ noLimits: noLimits ? true : undefined, stopLine: true, routeAsks: true }),
    });
    expect(await recorder.until(event => event.type === 'turn.completed')).toMatchObject({ ok: true });
    const { argv } = JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[] };
    const at = argv.indexOf('--disallowedTools');
    const denied = at < 0 ? [] : argv[at + 1]!.split(',');
    expect(denied.includes(tool)).toBe(!noLimits);
  });
}

for (const noLimits of [false, true]) {
  it(`saved native tool allowlist applies only below No limits: noLimits=${noLimits}`, async () => {
    const dump = join(root, 'native-allowlist.json');
    process.env.FAKE_CLAUDE_DUMP = dump;
    instance = await ClaudeDriver.create({ instanceId: 'p', displayName: 'Fixture', enabled: true, environment: {},
      config: { cli, permissionMode: 'acceptEdits', tools: ['Read'] },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: 't', cwd: root, text: 'fixture-only', noLimits: noLimits ? true : undefined,
      permissionNow: () => ({ noLimits: noLimits ? true : undefined, stopLine: true, routeAsks: true }),
    });
    expect(await recorder.until(event => event.type === 'turn.completed')).toMatchObject({ ok: true });
    const { argv } = JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[] };
    const at = argv.indexOf('--tools');
    expect(at >= 0).toBe(!noLimits);
    if (at >= 0) expect(argv[at + 1]).toBe('Read');
  });
}

it('reusing a thread recomputes saved native restrictions when the current level changes', async () => {
  const dump = join(root, 'level-change.json');
  process.env.FAKE_CLAUDE_DUMP = dump;
  instance = await ClaudeDriver.create({ instanceId: 'p', displayName: 'Fixture', enabled: true, environment: {},
    config: { cli, permissionMode: 'acceptEdits', disallowedTools: ['Bash'], tools: ['Read'] },
  });
  recorder = recordEvents(instance.adapter);
  let noLimits = true;
  const pids: number[] = [];
  for (const level of [true, false, true]) {
    noLimits = level;
    const { turnId } = await instance.adapter.sendTurn({ threadId: 't', cwd: root, text: 'fixture-only',
      permissionNow: () => ({ noLimits: noLimits ? true : undefined, stopLine: true, routeAsks: true }),
    });
    expect(await recorder.until(event => event.type === 'turn.completed' && event.turnId === turnId)).toMatchObject({ ok: true });
    const { argv, pid } = JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[]; pid: number };
    const at = argv.indexOf('--disallowedTools');
    expect((at < 0 ? [] : argv[at + 1]!.split(',')).includes('Bash')).toBe(!level);
    expect(argv.includes('--tools')).toBe(!level);
    pids.push(pid);
  }
  expect(new Set(pids).size).toBe(3);
});
