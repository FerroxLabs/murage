// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 MAIN-RULING NOLIMITS-1022 H1 (2026-11-25T17:28:43Z, from Sean 11-10/11-11/11-12: Full access and No limits ask only
// for deny rules and the wipe list): at Full access, on the owner's own turn, a command the reader cannot follow runs
// unless it is wipe-SHAPED; the key guard (.ssh) and the wipe list still ask; a send no owner surface proved stays Ask.
// Real server, real path: the owner's proven desktop send -> the bot's turn -> the fake engine asks the permission prompt
// tool about one command -> autoVerdict (server/auto-approve.ts) -> GET /api/decisions. The fake engine never runs it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

// the three unreadable everyday commands of the field probe (12/50 Full access cards, 3 of them reason=unreadable)
const UNREADABLE = ['bash -c "$CMD"', 'eval "$(ssh-agent -s)"', 'sh -c "ls $HOME"'];
// wipe-SHAPED once decoded (ruling part 1): each still asks at Full access
const WIPE_SHAPED = ['$(echo rm) -rf ~', "$'\\u0000rm' -rf ~", 'R=ls; let R=1; $R -rf ~', 'P=rm; $P -rf "$D"',
  // decoded text handed to a shell: `rm -rf ~` in base64, hex escapes and reversed (Opus self-review High 1)
  'echo cm0gLXJmIH4= | base64 -d | sh', "printf '\\x72\\x6d -\\x72\\x66 ~' | sh", "echo '~ fr- mr' | rev | sh"];
// the key guard, also when the command is unreadable or encoded (`cat ~/.ssh/id_rsa` in base64; Opus self-review High 2)
const KEYS = ['cat ~/.ssh/config', '$(echo cat) ~/.ssh/id_rsa', 'echo Y2F0IH4vLnNzaC9pZF9yc2E= | base64 -d | sh'];

let fixture: VerificationServer, headers: Record<string, string>, model: string, input: string;
async function api(method: string, path: string, body?: unknown, auth: Record<string, string> = headers) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function ok(method: string, path: string, body?: unknown, status = 200, auth?: Record<string, string>) {
  const answer = await api(method, path, body, auth);
  if (answer.status !== status) throw new Error(`setup: ${method} ${path} answered ${answer.status}`);
  return answer.body;
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const path=await import('node:path');
    process.env.FAKE_CLAUDE_PERM_TOOL='Bash';
    process.env.FAKE_CLAUDE_PERM_INPUT_FILE=path.join(process.env.MURAGE_DATA_DIR,'q22-input','command.json');
  ` });
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await ok('GET', '/api/desktop-secret', undefined, 200, {})).secret };
  await ok('POST', '/api/memory/action', { action: 'configure', mode: 'off' });
  model = (await ok('GET', '/api/instances')).instances.find((row: any) => row.instanceId === 'verification').models.options[0].id;
  mkdirSync(join(fixture.info.dataDir, 'q22-input'), { recursive: true });
  input = join(fixture.info.dataDir, 'q22-input', 'command.json');
}, 120000);
afterAll(async () => { await fixture?.close(); });

/** A bot at Full access (not No limits). */
async function fullAccessBot(name: string) {
  const bot = (await ok('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } }, 201)).bot;
  await ok('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' });
  const raised = await raiseLevel(api, bot.id, { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true });
  if (raised.status !== 200) throw new Error(`setup: raising to Full access answered ${raised.status}`);
  return bot;
}
const decisionsOf = async (botId: string): Promise<any[]> => (await ok('GET', '/api/decisions?limit=500')).decisions.filter((row: any) => row.botId === botId);
/** One send on the bot's thread whose turn asks about `command`; `proven` = the owner's desktop surface sent it.
 * Returns `decision:source` of the row that question got (a card or an automatic approval). */
async function sendAsks(bot: any, command: string, n: number, proven = true): Promise<string> {
  writeFileSync(input, JSON.stringify({ command }));
  const before = (await decisionsOf(bot.id)).length;
  const sent = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: 'POST', headers: { ...(proven ? headers : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: bot.threadId, text: `__fixture_permission_tool__ q22 full ${n}` }) });
  if (sent.status !== 202) throw new Error(`setup: send answered ${sent.status}`);
  let row: any;
  await expect.poll(async () => { row = (await decisionsOf(bot.id)).slice(before).find((r: any) => r.decision === 'card-shown' || r.decision === 'auto-approved'); return Boolean(row); },
    { timeout: 30000, interval: 100 }).toBe(true);
  // a card holds the turn; end it so the next send is not queued behind it
  if (row.decision === 'card-shown') await ok('POST', `/api/bots/${bot.id}/interrupt`, { threadId: row.threadId });
  await expect.poll(async () => (await ok('GET', '/api/bots')).bots.find((b: any) => b.id === bot.id)?.busy === true, { timeout: 15000 }).toBe(false);
  return `${row.decision}:${row.source}`;
}

it('Full access: an unreadable command that is not wipe-shaped runs on the owner\'s turn', async () => {
  const bot = await fullAccessBot('Q22 full unreadable');
  const asked: string[] = [];
  for (const [n, command] of UNREADABLE.entries()) asked.push(await sendAsks(bot, command, n));
  expect(asked).toEqual(UNREADABLE.map(() => 'auto-approved:full-access'));
}, 200000);

it('Full access: an obfuscated or unreadable wipe still asks', async () => {
  const bot = await fullAccessBot('Q22 full wipe');
  const asked: string[] = [];
  for (const [n, command] of WIPE_SHAPED.entries()) asked.push(await sendAsks(bot, command, n));
  // a card's decision row names only that BASE held it (implementation.ts card row), not which guard
  expect(asked.map(row => row.split(':')[0])).toEqual(WIPE_SHAPED.map(() => 'card-shown'));
}, 200000);

it('Full access: the key guard still asks before reading ~/.ssh, unreadable or encoded', async () => {
  const bot = await fullAccessBot('Q22 full key');
  const asked: string[] = [];
  for (const [n, command] of KEYS.entries()) asked.push(await sendAsks(bot, command, n));
  expect(asked.map(row => row.split(':')[0])).toEqual(KEYS.map(() => 'card-shown'));
}, 200000);

it('Full access: the wipe-shape read stays linear on a 128 KiB option run (Opus self-review High 3)', async () => {
  const { autoVerdict } = await import('./auto-approve.ts');
  const command = `$(echo a) -${'rf'.repeat(64 * 1024 - 8)}x`;
  const started = performance.now();
  autoVerdict({ id: 'q22-linear', autoApprove: true, fullAccess: true } as never, 'Bash', command, { fullAccessOrigin: 'owner', ownerStarted: true, commandText: command } as never);
  expect(performance.now() - started).toBeLessThan(3000);
}, 60000);

it('Full access: a send no owner surface proved stays Ask, unreadable command included', async () => {
  const bot = await fullAccessBot('Q22 full guest');
  expect(await sendAsks(bot, UNREADABLE[0]!, 0, false)).toMatch(/^card-shown:/);
}, 120000);

// deny = protected + refusals + wipe (Sean 11-10): a path the reader could not bound on a system folder, or a home path the
// command computes, is a protected path it could not place; it keeps its card at Full access (fork rewrite code-bugs B)
const PROTECTED = ['cp x /etc/"$X"', 'touch ~/"$X"'];
it('Full access: a computed path on a system folder or the home folder keeps its card', async () => {
  const bot = await fullAccessBot('Q22 full protected');
  const asked: string[] = [];
  for (const [n, command] of PROTECTED.entries()) asked.push(await sendAsks(bot, command, n + 20));
  expect(asked.map((row, n) => `${PROTECTED[n]} => ${row.split(':')[0]}`)).toEqual(PROTECTED.map(command => `${command} => card-shown`));
}, 200000);
