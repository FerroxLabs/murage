// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-nolimits (Sean 2026-11-25): a No limits bot still stopped to ask, turn after turn, in its owner's own thread.
// A turn the server itself starts there after the owner answers a card (here: the owner dismisses a credential card and the
// paused work resumes) carries no typed-message proof, so it was filed as another person's turn and judged as an Ask bot:
// even `ls` raised a card (`approvals: asked ... reason=no-grant ... level=ask`).
// Every row enters through the desktop routes of a booted server (POST /api/bots/:id/messages, then
// POST /api/bots/:id/secret-cards/:messageId/dismiss); the fake engine only emits permission DATA and never runs a command.
// The field log carries no command text (it is value-free by design), so the 50 commands are everyday shapes of the same
// class (`cmd=shell`), not quotes from it.
// NOT changed, and pinned by the last two rows: a send no owner surface proved (a loopback caller without the desktop
// secret) stays an Ask turn at every level, and so does the turn resumed from a card that any turn but the owner's typed one raised.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';

const COMMANDS: string[] = [
  'ls', 'ls -la', 'pwd', 'git status', 'git diff', 'git log --oneline -20', 'git branch -a', 'git add -A', "git commit -m 'wip'",
  'git push origin main', 'git fetch --all', 'git checkout -b feature/x', 'git stash list', 'cat package.json', 'cat README.md',
  'head -50 src/index.ts', 'tail -n 100 server.log', 'grep -rn TODO src', "rg 'approvals: asked' -n", "find . -name '*.ts' -not -path './node_modules/*'",
  'wc -l src/index.ts', 'npm install', 'npm test', 'npm run build', 'npx tsc --noEmit', 'npx vitest run', 'node scripts/build.mjs',
  'python3 -m pytest -q', 'pip install -r requirements.txt', 'mkdir -p build/out', 'cp a.txt b.txt', 'mv b.txt c.txt', 'touch notes.md',
  'rm -f build/out/tmp.txt', 'rm -rf build', 'echo hello > out.txt', 'sed -i s/a/b/ notes.md', "awk '{print $1}' data.csv", 'sort data.csv | uniq -c',
  'curl -sS https://example.com/health', 'date -u', 'whoami', 'uname -a', 'df -h', 'ps aux', 'env', 'which node', 'node --version',
  'docker ps', 'make test',
];
const WIPE = 'rm -rf /';
const DENIED = 'echo x > /etc/hosts';

let fixture: VerificationServer;
let desktop: Record<string, string>;
type Sender = 'desktop' | 'unproven';
async function api(method: string, path: string, body?: unknown, sender: Sender = 'desktop'): Promise<any> {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...(sender === 'desktop' ? desktop : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`setup: ${method} ${path} answered ${res.status}`);
  return res.json();
}
beforeAll(async () => {
  expect(COMMANDS).toHaveLength(50);
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // One turn asks for every command in order; each answer opens the next ask, and the last answer ends the turn.
  const replacement = `const q22file = q22Path.join(process.env.MURAGE_DATA_DIR, 'q22-next.json');
    const q22list = q22Fs.existsSync(q22file) ? JSON.parse(q22Fs.readFileSync(q22file, 'utf8')) : ['pwd'];
    const q22ask = index => emit({ type: 'request.opened', requestType: 'permission', tool: 'Bash', summary: q22list[index],
      toolCall: { name: 'Bash', input: { command: q22list[index], cwd: turn.cwd } }, requestId: turnId + '-ask-' + index, threadId: turn.threadId, turnId });
    q22Turns.set(turn.threadId, { next: 1, list: q22list, ask: q22ask });
    q22ask(0); return;`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    await import(${JSON.stringify(new URL('./testing/idle-load-preload.mjs', import.meta.url).href)});
    const fs=await import('node:fs'); const path=await import('node:path'); const {registerHooks}=await import('node:module');
    registerHooks({load(url,ctx,next){
      if(!url.endsWith('/fake-late-terminal-driver.ts'))return next(url,ctx);
      let source="import * as q22Fs from 'node:fs'; import * as q22Path from 'node:path'; const q22Turns = new Map();\\n"+fs.readFileSync(new URL(url),'utf8');
      if(!source.includes(${JSON.stringify(anchor)}))throw Error('fixture anchor changed');
      source=source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)});
      const respond='respondToRequest: async () => "unavailable" as const,';
      if(!source.includes(respond))throw Error('fixture respond anchor changed');
      source=source.replace(respond,
        'respondToRequest: async (threadId, requestId, response) => { const entry=active.get(threadId); const state=q22Turns.get(threadId); if(!entry||!state)return {state:"failed"} as const; setTimeout(()=>{ if(response.behavior==="allow"&&state.next<state.list.length){state.ask(state.next++);return;} emit({type:"item.completed",itemType:"assistant_text",origin:"engine",text:"fixture "+response.behavior,threadId,turnId:entry.turnId}); active.delete(threadId); q22Turns.delete(threadId); emit({type:"turn.completed",ok:true,threadId,turnId:entry.turnId});},2); return {state:"accepted"} as const; },');
      return {format:'module-typescript',shortCircuit:true,source};
    }});
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    const fake=makeLateTerminalDriver(),create=fake.create.bind(fake);
    fake.create=async input=>{const instance=await create(input);return {...instance,decisionAdapter:{respondToRequest:instance.adapter.respondToRequest.bind(instance.adapter),interruptTurn:instance.adapter.interruptTurn.bind(instance.adapter)}};};
    BUILT_IN_DRIVERS.push(fake);
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.q22={driver:'fakeLateTerminal',environment:{FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'q22-gate'),FAKE_LATE_AGENTS_ENV:path.join(process.env.MURAGE_DATA_DIR,'q22-agents-env.json')}};fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 60000);
afterAll(async () => { await fixture?.close(); });

async function newBot(name: string, level: Record<string, unknown>): Promise<{ id: string; threadId: string }> {
  const { bot } = await api('POST', '/api/bots', { name, modelSelection: { instanceId: 'q22', model: 'late-1' } });
  await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' });
  await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, level);
  return bot;
}
/** The thread's decision rows once `done` holds or the wait runs out; a wait that runs out is reported by the caller's assertion. */
async function settle(threadId: string, done: (rows: any[]) => boolean, ms = 40000): Promise<{ cards: number; auto: number; sources: string[] }> {
  const until = Date.now() + ms;
  let rows: any[] = [];
  for (;;) {
    rows = (await api('GET', '/api/decisions?limit=500')).decisions.filter((row: any) => row.threadId === threadId);
    if (done(rows) || Date.now() > until) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const shown = rows.filter(row => row.decision === 'card-shown'), auto = rows.filter(row => row.decision === 'auto-approved');
  return { cards: shown.length, auto: auto.length, sources: [...new Set([...shown, ...auto].map(row => `${row.decision}:${row.source}`))].sort() };
}

const dataFile = (name: string): string => join(fixture.info.dataDir, name);
async function until(what: string, read: () => boolean | Promise<boolean>, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await read())) { if (Date.now() > end) throw new Error(`setup: timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 50)); }
}
/** The engine holds each turn at its start until the test lets it go; `list` is what it then asks for, in order. */
const arm = (list: string[]): void => { for (const name of ['q22-gate', 'q22-gate.waiting']) rmSync(dataFile(name), { force: true }); writeFileSync(dataFile('q22-next.json'), JSON.stringify(list)); };
const idle = async (botId: string): Promise<boolean> => (await api('GET', '/api/bots')).bots.find((bot: any) => bot.id === botId)?.busy !== true;
/** The owner's typed turn raises a credential card while the engine holds the turn, asks for one command and ends. */
async function typedTurnWithCredentialCard(bot: { id: string; threadId: string }): Promise<string> {
  arm(['pwd']);
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'q22 first', threadId: bot.threadId });
  await until('the held turn', () => existsSync(dataFile('q22-gate.waiting')));
  const env = JSON.parse(readFileSync(dataFile('q22-agents-env.json'), 'utf8')) as Record<string, string>;
  const card = await fetch(fixture.info.url + '/api/internal/request-credential', { method: 'POST', headers: { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, credentialId: 'openaiImageApiKey', reason: 'q22 continuation under test' }) });
  if (card.status !== 201) throw new Error(`setup: credential card answered ${card.status}`);
  const { messageId } = await card.json() as { messageId: string };
  writeFileSync(dataFile('q22-gate'), '');
  await until('the typed turn to end', async () => (await settle(bot.threadId, rows => rows.length >= 1, 0)).auto === 1 && await idle(bot.id));
  return messageId;
}
/** The owner dismisses the card; the server starts the resumed turn, whose engine asks for `list` in order. */
async function resumedTurn(bot: { id: string; threadId: string }, messageId: string, list: string[]): Promise<void> {
  arm(list);
  const answer = await api('POST', `/api/bots/${bot.id}/secret-cards/${messageId}/dismiss`, { threadId: bot.threadId });
  if (answer.resumed !== true) throw new Error('setup: the dismissed card did not resume the turn');
  await until('the resumed turn', () => existsSync(dataFile('q22-gate.waiting')));
  writeFileSync(dataFile('q22-gate'), '');
}

it('50 everyday commands on the turn a No limits bot resumes in its owner-only thread raise 0 cards', async () => {
  const bot = await newBot('Q22 fifty', { noLimits: true, acknowledgeNoLimits: true });
  try {
    await resumedTurn(bot, await typedTurnWithCredentialCard(bot), COMMANDS);
    const seen = await settle(bot.threadId, rows => rows.some(row => row.decision === 'card-shown') || rows.filter(row => row.decision === 'auto-approved').length >= 1 + COMMANDS.length);
    expect(seen).toEqual({ cards: 0, auto: 51, sources: ['auto-approved:no-limits'] });
  } finally { await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 90000);

it('a wipe on the same resumed No limits turn still asks', async () => {
  const bot = await newBot('Q22 wipe', { noLimits: true, acknowledgeNoLimits: true });
  try {
    await resumedTurn(bot, await typedTurnWithCredentialCard(bot), [WIPE]);
    const seen = await settle(bot.threadId, rows => rows.length >= 2);
    expect(seen).toEqual({ cards: 1, auto: 1, sources: ['auto-approved:no-limits', 'card-shown:always-ask'] });
  } finally { await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 90000);

// A guard row, not a witness of this fix (the level reader is unchanged here): the fixture engine carries no engine
// identity, which Full access holds as an unread call whatever the command, so this row reads the policy itself, as
// full-deny-1018.test.ts does for the whole deny table.
it('a wipe still holds the owner’s own turn on Full access; a protected-path write and its ordinary twin run', async () => {
  const { autoVerdict } = await import('./auto-approve.ts');
  const full = { id: 'owned', autoApprove: true, fullAccess: true };
  const verdict = (command: string) => autoVerdict(full, 'Bash', command, { fullAccessOrigin: 'owner', ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, commandCwd: '/w' });
  // OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn runs a protected-path write, as No limits does; a wipe still holds
  expect([verdict('rm -rf ~').approve, verdict(DENIED).approve, verdict('echo x > notes.txt').approve]).toEqual([null, expect.any(String), expect.any(String)]);
});

// The lift is bound to the card the owner's own typed turn raised. A turn that only resumed (it is filed as unattended
// automation, not as the owner typing) raises a second card here; the turn resumed from THAT card is an Ask turn, as on
// base. (A send no owner surface proved gets no tool token at all, so it cannot raise a credential card.)
it('a card raised by a turn that was not the owner typing resumes as an Ask turn', async () => {
  const bot = await newBot('Q22 chained card', { noLimits: true, acknowledgeNoLimits: true });
  try {
    const first = await typedTurnWithCredentialCard(bot);
    arm(['pwd']);
    const answer = await api('POST', `/api/bots/${bot.id}/secret-cards/${first}/dismiss`, { threadId: bot.threadId });
    if (answer.resumed !== true) throw new Error('setup: the dismissed card did not resume the turn');
    await until('the resumed turn', () => existsSync(dataFile('q22-gate.waiting')));
    const env = JSON.parse(readFileSync(dataFile('q22-agents-env.json'), 'utf8')) as Record<string, string>;
    const card = await fetch(fixture.info.url + '/api/internal/request-credential', { method: 'POST', headers: { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, credentialId: 'openaiImageApiKey', reason: 'q22 chained card' }) });
    if (card.status !== 201) throw new Error(`setup: second credential card answered ${card.status}`);
    const { messageId: second } = await card.json() as { messageId: string };
    if (second === first) throw new Error('setup: the second card reused the first');
    writeFileSync(dataFile('q22-gate'), '');
    await until('the resumed turn to end', async () => (await settle(bot.threadId, rows => rows.length >= 2, 0)).auto === 2 && await idle(bot.id));
    await resumedTurn(bot, second, ['ls']);
    const seen = await settle(bot.threadId, rows => rows.length >= 3);
    expect({ cards: seen.cards, auto: seen.auto }).toEqual({ cards: 1, auto: 2 });
  } finally { await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 90000);

it('a send no owner surface proved stays an Ask turn on a No limits bot', async () => {
  const bot = await newBot('Q22 unproven', { noLimits: true, acknowledgeNoLimits: true });
  try {
    arm(['ls']);
    await api('POST', `/api/bots/${bot.id}/messages`, { text: 'q22 unproven', threadId: bot.threadId }, 'unproven');
    await until('the held turn', () => existsSync(dataFile('q22-gate.waiting')));
    writeFileSync(dataFile('q22-gate'), '');
    const seen = await settle(bot.threadId, rows => rows.length >= 1);
    expect({ cards: seen.cards, auto: seen.auto }).toEqual({ cards: 1, auto: 0 });
  } finally { await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 90000);
