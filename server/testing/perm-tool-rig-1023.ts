// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A booted server whose fake engine asks the permission prompt tool about one command per send (1.0.23 q1023-nolimits-fix).
// Real path: the owner's proven desktop send -> the bot's turn -> the fake engine's permission question for `tool` ->
// the decision layer -> GET /api/decisions. The fake engine never runs the command.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { raiseLevel } from './raise-level.ts';

export type PermToolRig = Awaited<ReturnType<typeof permToolRig>>;
/** `tool` is the engine tool the question names: 'Bash' is read as a POSIX shell, 'PowerShell' as PowerShell. */
export async function permToolRig(tool: 'Bash' | 'PowerShell') {
  const fixture: VerificationServer = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const path=await import('node:path');
    process.env.FAKE_CLAUDE_PERM_TOOL=${JSON.stringify(tool)};
    process.env.FAKE_CLAUDE_PERM_INPUT_FILE=path.join(process.env.MURAGE_DATA_DIR,'q23-input','command.json');
  ` });
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown, auth: Record<string, string> = headers) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (method: string, path: string, body?: unknown, status = 200, auth?: Record<string, string>) => {
    const answer = await api(method, path, body, auth);
    if (answer.status !== status) throw new Error(`setup: ${method} ${path} answered ${answer.status}`);
    return answer.body;
  };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await ok('GET', '/api/desktop-secret', undefined, 200, {})).secret };
  await ok('POST', '/api/memory/action', { action: 'configure', mode: 'off' });
  const model = (await ok('GET', '/api/instances')).instances.find((row: any) => row.instanceId === 'verification').models.options[0].id;
  mkdirSync(join(fixture.info.dataDir, 'q23-input'), { recursive: true });
  const input = join(fixture.info.dataDir, 'q23-input', 'command.json');
  const bot = async (name: string, level: 'full' | 'no-limits') => {
    const made = (await ok('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } }, 201)).bot;
    await ok('PATCH', `/api/bots/${made.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' });
    const raised = await raiseLevel(api, made.id, level === 'no-limits' ? { noLimits: true, acknowledgeNoLimits: true }
      : { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true });
    if (raised.status !== 200) throw new Error(`setup: raising ${name} answered ${raised.status}`);
    return made;
  };
  const decisionsOf = async (botId: string): Promise<any[]> => (await ok('GET', '/api/decisions?limit=500')).decisions.filter((row: any) => row.botId === botId);
  /** One owner send whose turn asks about `command`. Returns `decision:source` of the row that question got. */
  const sendAsks = async (asker: any, command: string, n: number): Promise<string> => {
    writeFileSync(input, JSON.stringify({ command }));
    const before = (await decisionsOf(asker.id)).length;
    const sent = await fetch(`${fixture.info.url}/api/bots/${asker.id}/messages`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: asker.threadId, text: `__fixture_permission_tool__ q23 nolimits fix ${n}` }) });
    if (sent.status !== 202) throw new Error(`setup: send answered ${sent.status}`);
    let row: any;
    await expect.poll(async () => { row = (await decisionsOf(asker.id)).slice(before).find((r: any) => r.decision === 'card-shown' || r.decision === 'auto-approved'); return Boolean(row); },
      { timeout: 30000, interval: 100 }).toBe(true);
    // a card holds the turn; end it so the next send is not queued behind it
    if (row.decision === 'card-shown') await ok('POST', `/api/bots/${asker.id}/interrupt`, { threadId: row.threadId });
    await expect.poll(async () => (await ok('GET', '/api/bots')).bots.find((b: any) => b.id === asker.id)?.busy === true, { timeout: 15000 }).toBe(false);
    return `${row.decision}:${row.source}`;
  };
  /** Every command asked in turn on one bot at `level`: `command => decision:source` per row. */
  const outcomes = async (name: string, level: 'full' | 'no-limits', commands: readonly string[]): Promise<string[]> => {
    const asker = await bot(name, level);
    const rows: string[] = [];
    for (const [n, command] of commands.entries()) rows.push(`${command} => ${await sendAsks(asker, command, n)}`);
    return rows;
  };
  return { outcomes, close: () => fixture.close() };
}
