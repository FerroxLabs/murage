// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 MAIN-RULING NOLIMITS-1022 H1 correction (2026-11-25T18:57:03Z, Sean 11-12 binding): at No limits only wipe-shaped
// commands ask, obfuscated ones included; the key guard (.ssh) does not ask at No limits; a send no owner surface proved
// stays Ask. Real server, real path: the owner's proven desktop send -> the No limits bot's turn -> the fake engine asks
// the permission prompt tool about one command -> the decision layer's No limits wipe read (server/decision/implementation.ts
// describeNoLimits and action.ts describeOwnerNoLimits, both noLimitsWipe) -> GET /api/decisions. The fake engine never runs it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

// obfuscated wipes: each asks at No limits (decoded: `rm -rf ~`, and `rm -rf /` behind $IFS, which leaves a later ~ unexpanded)
const OBFUSCATED = ['echo cm0gLXJmIH4= | base64 -d | sh', "printf '\\x72\\x6d -\\x72\\x66 ~' | sh", "echo '~ fr- mr' | rev | sh",
  'rm$IFS-rf$IFS/', '$(echo rm) -rf ~', "python3 -c 'import os,base64;os.system(base64.b64decode(\"cm0gLXJmIH4=\").decode())'",
  `pwsh -ec ${Buffer.from('Remove-Item -Recurse -Force ~', 'utf16le').toString('base64')}`,
  // a literal payload decoded where it runs (`rm -rf /` in base64 and in hex; Opus self-review r5 High 2)
  '$(echo cm0gLXJmIC8= | base64 -d)', `perl -e 'system(pack("H*","726d202d7266202f"))'`,
  // behind a concatenated literal, and a quoted body sh -c runs (Astra precheck r5 pass 3 High 1)
  `python3 -c 'import os,base64;os.system(" " + base64.b64decode("cm0gLXJmIC8=").decode())'`, "bash -c 'echo cm0gLXJmIH4= | base64 -d | sh'"];
// what No limits runs: unreadable non-wipe commands, a key read (no key guard at No limits), plainly or encoded, and
// everyday commands whose words look like a decoder or a sink (`rev-parse`, `$(...)`, `cp -rf`)
const RUNS = ['bash -c "$CMD"', 'eval "$(ssh-agent -s)"', 'sh -c "ls $HOME"', 'cat ~/.ssh/config',
  'echo Y2F0IH4vLnNzaC9pZF9yc2E= | base64 -d | sh', 'X=$(git rev-parse HEAD) && echo "$X"', 'cp -rf ~/notes ~/notes-copy',
  // a decoder and a sink with no wipe in what runs (Astra r5 High, Opus self-review r5 High 1): wipe-only, so they run
  'eval "$(ssh-agent -s)"; echo -e "\\x1b[32mok"', `node -e 'eval(atob("Y29uc29sZS5sb2coMSk="))'`,
  `python3 -c "import subprocess; subprocess.run(['ls']); print('\\033[32mdone')"`,
  // a decoded wipe printed, not run, beside an unrelated eval (Astra precheck r5 pass 2 High)
  'eval true; echo cm0gLXJmIH4= | base64 -d', "eval true; echo 'echo cm0gLXJmIC8= | base64 -d | sh'"];

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

/** A bot at No limits. */
async function noLimitsBot(name: string) {
  const bot = (await ok('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } }, 201)).bot;
  await ok('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' });
  const raised = await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true });
  if (raised.status !== 200) throw new Error(`setup: raising to No limits answered ${raised.status}`);
  return bot;
}
const decisionsOf = async (botId: string): Promise<any[]> => (await ok('GET', '/api/decisions?limit=500')).decisions.filter((row: any) => row.botId === botId);
/** One send on the bot's thread whose turn asks about `command`; `proven` = the owner's desktop surface sent it.
 * Returns `decision:source` of the row that question got (a card or an automatic approval). */
async function sendAsks(bot: any, command: string, n: number, proven = true): Promise<string> {
  writeFileSync(input, JSON.stringify({ command }));
  const before = (await decisionsOf(bot.id)).length;
  const sent = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: 'POST', headers: { ...(proven ? headers : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: bot.threadId, text: `__fixture_permission_tool__ q22 nolimits ${n}` }) });
  if (sent.status !== 202) throw new Error(`setup: send answered ${sent.status}`);
  let row: any;
  await expect.poll(async () => { row = (await decisionsOf(bot.id)).slice(before).find((r: any) => r.decision === 'card-shown' || r.decision === 'auto-approved'); return Boolean(row); },
    { timeout: 30000, interval: 100 }).toBe(true);
  // a card holds the turn; end it so the next send is not queued behind it
  if (row.decision === 'card-shown') await ok('POST', `/api/bots/${bot.id}/interrupt`, { threadId: row.threadId });
  await expect.poll(async () => (await ok('GET', '/api/bots')).bots.find((b: any) => b.id === bot.id)?.busy === true, { timeout: 15000 }).toBe(false);
  return `${row.decision}:${row.source}`;
}

it('No limits: an obfuscated wipe asks on the owner\'s turn', async () => {
  const bot = await noLimitsBot('Q22 nolimits obfuscated');
  const asked: string[] = [];
  for (const [n, command] of OBFUSCATED.entries()) asked.push(await sendAsks(bot, command, n));
  expect(asked.map((row, n) => `${OBFUSCATED[n]} => ${row.split(':')[0]}`)).toEqual(OBFUSCATED.map(command => `${command} => card-shown`));
}, 300000);

it('No limits: an unreadable non-wipe command, a key read and decoder-looking everyday commands run', async () => {
  const bot = await noLimitsBot('Q22 nolimits runs');
  const asked: string[] = [];
  for (const [n, command] of RUNS.entries()) asked.push(await sendAsks(bot, command, n + 10));
  expect(asked.map((row, n) => `${RUNS[n]} => ${row}`)).toEqual(RUNS.map(command => `${command} => auto-approved:no-limits`));
}, 300000);

it('No limits: a send no owner surface proved stays Ask, unreadable command included', async () => {
  const bot = await noLimitsBot('Q22 nolimits guest');
  expect(await sendAsks(bot, RUNS[0]!, 0, false)).toMatch(/^card-shown:/);
}, 120000);
