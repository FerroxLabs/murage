// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadOpenclawPackage } from '../../testing/openclaw-package-proof.mjs';
import { recordEvents } from '../../testing/events.ts';
import { ensureDirs } from '../../config.ts';
import { autoVerdict } from '../../auto-approve.ts';
import { createAcpDriver } from './core.ts';
import { createOpenclawPrePromptGuard, OPENCLAW_NO_LIMITS_DIRECTIVE, openclawSupport } from './openclaw.ts';
import { removeTempDir } from '../../testing/cleanup.ts';
import { useOutsideStoreFixture } from '../../testing/outside-store-fixture.ts';
const packageDir = process.env.OPENCLAW_PACKAGE_DIR;
it.skipIf(!packageDir)('N2 E1 real OpenClaw full mode and ask=always relay exec through ACP to Murage wipe verdicts', async () => {
  ensureDirs();
  const real = loadOpenclawPackage(packageDir!);
  const entry: Record<string, unknown> = { permissionMode: 'read-only' };
  real.applySessionExecutionSettings(entry, { permissionMode: 'full' });
  expect(entry.permissionMode).toBe('full');
  const directive = real.extractExecDirective(`${OPENCLAW_NO_LIMITS_DIRECTIVE}\nfixture`);
  expect(directive).toMatchObject({ execSecurity: 'full', execAsk: 'always', invalidSecurity: false, invalidAsk: false, cleaned: 'fixture' });
  expect(real.resolveSessionPermissionExecPolicy({ mode: entry.permissionMode }, { security: directive.execSecurity, ask: directive.execAsk })).toMatchObject({ security: 'full', ask: 'always' });
  expect(real.requiresExecApproval({ security: 'full', ask: 'always' })).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'openclaw-package-witness-'));
  const log = join(root, 'decisions.jsonl');
  const cli = join(process.cwd(), 'server/testing/openclaw-package-relay-cli.mjs'); chmodSync(cli, 0o755);
  const driver = createAcpDriver({ ...openclawSupport, prePrompt: createOpenclawPrePromptGuard({ probeVersion: async () => real.packageVersion,
    call: async (_cli, _method, params) => { real.applySessionExecutionSettings(entry, params); return { ok: true, key: params.key, entry }; } }) });
  const instance = await driver.create({ instanceId: 'real-openclaw', displayName: 'OpenClaw', enabled: true, config: { cli, fullAuto: false },
    environment: { OPENCLAW_PACKAGE_DIR: packageDir!, OPENCLAW_WITNESS_LOG: log } });
  const events = recordEvents(instance.adapter);
  const verdicts: Array<{ command: string; approve: string | null; rule?: string }> = [];
  const unsubscribe = instance.adapter.onEvent(event => {
    if (event.type !== 'request.opened') return;
    const command = (event.toolCall?.input as { command: string }).command;
    const verdict = autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, event.tool, command, {
      commandText: command, commandCwd: root, fullAccessOrigin: 'owner', ownerStarted: true, stopLine: null,
      promptFacts: { cwd: root, home: root }, unseen: { platform: 'posix' },
    });
    verdicts.push({ command, approve: verdict.approve, rule: verdict.rule });
    void instance.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: verdict.approve ? 'allow' : 'deny' });
  });
  try {
    const sent = await instance.adapter.sendTurn({ threadId: 'real-openclaw-owner', text: 'fixture', cwd: root, noLimits: true, stopLine: true });
    const done = await events.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
    expect(done, JSON.stringify(events.events.filter(e => e.type === "runtime.error"))).toMatchObject({ ok: true });
    expect(verdicts).toHaveLength(3);
    expect(verdicts.map(v => Boolean(v.approve))).toEqual([true, true, false]);
    expect(verdicts[2]!.rule).toBe('delete-root');
    const decisions = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(decisions.map(d => d.decision)).toEqual(['allow-once', 'allow-once', 'deny']);
    if (process.env.OPENCLAW_PROOF_REPORT) writeFileSync(process.env.OPENCLAW_PROOF_REPORT, JSON.stringify({ version: real.packageVersion, files: real.files, directive, entry, verdicts, decisions }, null, 2));
  } finally { unsubscribe(); events.stop(); await instance.dispose(); await removeTempDir(root); }
}, 30_000);
useOutsideStoreFixture();
