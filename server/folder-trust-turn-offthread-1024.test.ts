// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 real logs (N3): `turn.folder-trust` held the serving loop 65 s in ONE call (and 31-33 s three more times): one blocked file call in
// the turn's folder-trust step (index.ts folderTrustForTurn: the folder -> git root chain, the desk checks, the engine's trust file) froze
// the whole app, because it ran on the main thread. A real booted server runs a real turn in a folder whose first file call sleeps its thread
// (server/testing/slow-trust-fs-preload.mjs); the loop must keep answering while the turn waits for its one trust answer.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FolderTrustStore } from './folder-trust.ts';
import { fakeEngineServerArgs } from './testing/fake-engine-server.ts';
import { freePortBlock } from './testing/ports.ts';
import { removeTempDir, waitForExit } from './testing/cleanup.ts';

const serverDir = dirname(fileURLToPath(import.meta.url)), cli = join(serverDir, 'testing/fake-acp-cli.ts'), preload = join(serverDir, 'testing/slow-trust-fs-preload.mjs');
const SLOW_MS = 3000;
let root: string, base: string, child: ChildProcess | undefined, headers: Record<string, string>, output = '';
const companionToken = randomBytes(32).toString('hex');
const key = (name: string) => join(root, name);
const request = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as any };
};
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'trust-offthread-')));
  chmodSync(cli, 0o755);
  mkdirSync(key('.murage')); mkdirSync(key('.fuigo'));
  writeFileSync(key('.fuigo/auth.json'), '{}');
  for (const name of ['slow-folder', 'quiet-folder', 'slow-room', 'slow-worktree', 'decline-folder', 'race-folder', 'race-other']) { mkdirSync(key(name)); writeFileSync(join(key(name), 'AGENTS.md'), `configuration-marker-${name}`); }
  // a linked git worktree: its `.git` is a FILE, so the folder's own git key reads the file and its gitdir (the saved-decision lookup)
  mkdirSync(key('main-repo/.git/worktrees/slow-worktree'), { recursive: true });
  writeFileSync(key('main-repo/.git/worktrees/slow-worktree/commondir'), '../..\n');
  writeFileSync(key('main-repo/.git/worktrees/slow-worktree/gitdir'), `${key('slow-worktree/.git')}\n`);
  writeFileSync(join(key('slow-worktree'), '.git'), `gitdir: ${key('main-repo/.git/worktrees/slow-worktree')}\n`);
  mkdirSync(key('home-folder')); writeFileSync(join(key('home-folder'), 'AGENTS.md'), 'configuration-marker-home-folder');
  mkdirSync(key('realcwd-folder')); writeFileSync(join(key('realcwd-folder'), 'AGENTS.md'), 'configuration-marker-realcwd-folder');
  mkdirSync(key('launch-folder')); writeFileSync(join(key('launch-folder'), 'AGENTS.md'), 'configuration-marker-launch-folder');
  const saved = new FolderTrustStore(key('.murage/folder-trust.json'));
  saved.remember(key('home-folder'), 'trust', 'picker');
  saved.remember(key('launch-folder'), 'trust', 'picker');
  saved.remember(key('realcwd-folder'), 'trust', 'picker');
  saved.remember(key('slow-folder'), 'trust', 'picker');
  saved.remember(key('quiet-folder'), 'trust', 'picker');
  saved.remember(key('decline-folder'), 'trust', 'picker');
  saved.remember(key('race-folder'), 'trust', 'picker'); saved.remember(key('race-other'), 'trust', 'picker');
  saved.remember(key('slow-room'), 'trust', 'picker');
  saved.remember(key('slow-worktree'), 'trust', 'picker'); saved.remember(key('main-repo'), 'trust', 'picker');
  const engine = { driver: 'fuigoAgent', environment: { FAKE_ACP_VERSION: '1.0.62', FAKE_ACP_MODE: 'folder-trust', FAKE_ACP_TRUST_V: '2', FAKE_ACP_MCP_READY: '1', FAKE_ACP_TRUST_LOG: key('wire.jsonl'), FAKE_ACP_TRUST_DECLINE_FILE: key('.fuigo/trusted_folders.toml'), FAKE_ACP_TRUST_DECLINE_KEY: `${key('decline-folder')}\n${key('race-folder')}` }, config: { cli, fullAuto: false } };
  writeFileSync(key('.murage/config.json'), JSON.stringify({ defaultModel: { instanceId: 'fixture', model: 'fake-acp-model' }, instances: { fixture: engine } }));
  const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', preload, ...fakeEngineServerArgs(join(serverDir, 'index.ts'))], { cwd: join(serverDir, '..'), windowsHide: true,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, NODE_ENV: 'test', MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: '1', MURAGE_ACP_POOL: '1', MURAGE_COMPANION_TOKEN: companionToken,
      SLOW_TRUST_ROOT: key('slow-folder'), SLOW_TRUST_ROOT2: key('slow-room'), SLOW_TRUST_ROOT3: key('slow-worktree'), SLOW_TRUST_LOG3: key('slow-worktree.log'), SLOW_TRUST_EXACT4: root, SLOW_TRUST_LOG4: key('home.log'), SLOW_TRUST_ARM4: key('arm-home'),
      SLOW_TRUST_EXACT5: key('.fuigo/trusted_folders.toml'), SLOW_TRUST_LOG5: key('launch.log'), SLOW_TRUST_ARM5: key('arm-launch'),
      SLOW_TRUST_EXACT6: key('realcwd-folder'), SLOW_TRUST_LOG6: key('realcwd.log'), SLOW_TRUST_ARM6: key('arm-realcwd'),
      SLOW_TRUST_GATE_FILE: key('.fuigo/trusted_folders.toml'),
      ...Object.fromEntries(['SNAP', 'REFRESH', 'BACKGROUND'].flatMap(gate => [[`SLOW_TRUST_GATE_${gate}_ARM`, key(`arm-${gate}`)], [`SLOW_TRUST_GATE_${gate}_RELEASE`, key(`release-${gate}`)], [`SLOW_TRUST_GATE_${gate}_LOG`, key(`gate-${gate}.log`)]])),
      SLOW_TRUST_MS: String(SLOW_MS), SLOW_TRUST_LOG: key('slow.log'), SLOW_TRUST_LOG2: key('slow-room.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', bytes => { output += bytes; }); child.stderr?.on('data', bytes => { output += bytes; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Isolated fixture failed to start: ' + output.slice(-4000));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const proof = await fetch(base + '/api/desktop-secret').then(response => response.json()) as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  expect((await request('POST', '/api/memory/action', { action: 'configure', mode: 'off' })).status).toBe(200);
  expect((await request('POST', '/api/no-limits/terms', { acknowledgeNoLimits: true })).status).toBe(200);
}, 60_000);
afterAll(async () => { if (child) await waitForExit(child, { signal: 'SIGTERM' }); if (root) await removeTempDir(root); });

async function bot(folder: string) {
  const created = await request('POST', '/api/bots', { name: 'Trust fixture', modelSelection: { instanceId: 'fixture', model: 'fake-acp-model' } });
  expect(created.status).toBe(201);
  const value = created.body.bot as { id: string; threadId: string };
  expect((await request('PATCH', `/api/bots/${value.id}`, { autoApprove: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const review = await request('POST', `/api/bots/${value.id}/permissions/refresh`, { scope: 'open', targetLevel: 'no-limits' });
  const saved = await request('PATCH', `/api/bots/${value.id}`, { settingsScope: 'defaults', previewId: review.body.previewId, ifRev: review.body.botRev, fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true });
  expect(saved.status).toBe(200);
  expect((await request('POST', `/api/bots/${value.id}/permissions/refresh`, { scope: 'open', rosterId: review.body.rosterId, targetLevel: review.body.targetLevel, afterRev: saved.body.bot?.permissionRev ?? saved.body.permissionRev })).status).toBe(200);
  expect((await request('PATCH', `/api/bots/${value.id}`, { cwd: folder })).status).toBe(200);
  return value;
}
async function roomTurn(folder: string) {
  const member = await bot(folder);
  const made = await request('POST', '/api/groups', { name: 'Trust room', memberIds: [member.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: member.id } } });
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  const room = made.body.group as { id: string };
  const pinned = await request('PATCH', `/api/groups/${room.id}`, { cwd: folder });
  expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
  let stop = false, worst = 0;
  const poll = (async () => {
    let last = Date.now();
    while (!stop) {
      try { await fetch(base + '/api/health'); } catch { /* keep polling */ }
      const now = Date.now(); worst = Math.max(worst, now - last); last = now;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  try {
    expect((await request('POST', `/api/groups/${room.id}/messages`, { text: 'go' })).status).toBeLessThan(300);
    // the room's member engine reached the folder question: the turn was dispatched with its trust answer
    await expect.poll(() => existsSync(key('wire.jsonl')) && readFileSync(key('wire.jsonl'), 'utf8').includes(`"workspace":${JSON.stringify(folder)}`), { timeout: 20_000, message: (existsSync(key('wire.jsonl')) ? [...readFileSync(key('wire.jsonl'), 'utf8').matchAll(/"workspace":"[^"]*"/g)].map(m => m[0]).join(' ') : 'no wire') + ' ' + folder }).toBe(true);
  } finally { stop = true; await poll; }
  return worst;
}
/** Runs one turn and returns the longest gap the loop left a /api/health call unanswered while it ran. */
async function turnGap(value: { id: string; threadId: string }) {
  let stop = false, worst = 0;
  const poll = (async () => {
    let last = Date.now();
    while (!stop) {
      try { await fetch(base + '/api/health'); } catch { /* keep polling */ }
      const now = Date.now(); worst = Math.max(worst, now - last); last = now;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  try {
    expect((await request('POST', `/api/bots/${value.id}/messages`, { threadId: value.threadId, text: 'go' })).status).toBe(202);
    await expect.poll(async () => (await request('GET', '/api/bots?messages=0')).body.bots.find((entry: any) => entry.id === value.id)?.busy, { timeout: 40_000, message: output.slice(-2000) }).toBe(false);
  } finally { stop = true; await poll; }
  return { worst, messages: (await request('GET', `/api/threads/${value.threadId}/messages?limit=200`)).body.messages as any[] };
}

it('a blocked file call in the turn\'s folder-trust step does not freeze the loop, and the turn still gets its one trust answer', async () => {
  const quiet = await turnGap(await bot(key('quiet-folder')));
  expect(JSON.stringify(quiet.messages)).toContain('configuration-marker-quiet-folder');
  const slow = await turnGap(await bot(key('slow-folder')));
  expect(slow.worst, `the loop went unanswered ${slow.worst} ms inside one blocked call`).toBeLessThan(SLOW_MS / 3);
  expect(existsSync(key('slow.log')) ? readFileSync(key('slow.log'), 'utf8') : '', 'the folder-trust step made a synchronous file call on the slow folder').toBe('');
  expect(JSON.stringify(slow.messages), 'the turn is not refused: the trust answer is the same as without the stuck call').toContain('configuration-marker-slow-folder');
}, 120_000);

it('the room turn takes the same path: a blocked file call in its folder-trust step does not freeze the loop', async () => {
  const worst = await roomTurn(key('slow-room'));
  expect(worst, `the loop went unanswered ${worst} ms inside one blocked call`).toBeLessThan(SLOW_MS / 3);
  expect(existsSync(key('slow-room.log')) ? readFileSync(key('slow-room.log'), 'utf8') : '', 'the room turn made a synchronous file call on the slow folder').toBe('');
}, 120_000);

it('a linked git worktree takes the same path: the file calls of its git key are answered off the serving thread too', async () => {
  const slow = await turnGap(await bot(key('slow-worktree')));
  expect(slow.worst, `the loop went unanswered ${slow.worst} ms inside one blocked call`).toBeLessThan(SLOW_MS / 3);
  expect(existsSync(key('slow-worktree.log')) ? readFileSync(key('slow-worktree.log'), 'utf8') : '', 'the folder-trust step made a synchronous file call on the worktree').toBe('');
  expect(slow.messages.filter((message: any) => message.card?.folderTrust), 'the saved answer for the main repository applies: no card').toEqual([]);
}, 120_000);

// 1.0.24 (Astra 5fb348f5bf A): a native turn with no FUIGO_HOME resolves the engine's home as the canonical HOME (folder-trust.ts
// fuigoHomeFromEnv): that realpath is a file call on the turn's folder-trust path too, and it was made live, outside the snapshot.
it('a native turn with no FUIGO_HOME resolves the Fuigo home off the serving thread', async () => {
  const value = await bot(key('home-folder'));
  writeFileSync(key('arm-home'), '');
  try {
    const turn = await turnGap(value);
    expect(turn.worst, `the loop went unanswered ${turn.worst} ms inside one blocked call`).toBeLessThan(SLOW_MS / 3);
    expect(existsSync(key('home.log')) ? readFileSync(key('home.log'), 'utf8') : '', 'the folder-trust step resolved the home with a synchronous file call').toBe('');
    expect(JSON.stringify(turn.messages), 'the turn still gets its trust answer').toContain('configuration-marker-home-folder');
  } finally { rmSync(key('arm-home'), { force: true }); }
}, 120_000);

// 1.0.24 S03 (Astra 5f3b49f69b High): the ACP launch reads the turn's trust source again AFTER the trust step (FolderTrustIndex.sourceNow:
// drivers/acp/core.ts launchSourceRevision and every epoch check), and that read statted the engine's trust file live on the serving thread.
it('the ACP launch checks the trust source again without a file call on the serving thread', async () => {
  const value = await bot(key('launch-folder'));
  writeFileSync(key('arm-launch'), '');
  try {
    const turn = await turnGap(value);
    expect(turn.worst, `the loop went unanswered ${turn.worst} ms inside one blocked call`).toBeLessThan(SLOW_MS / 3);
    expect(existsSync(key('launch.log')) ? readFileSync(key('launch.log'), 'utf8') : '', 'the launch read the engine trust file with a synchronous file call').toBe('');
    expect(JSON.stringify(turn.messages), 'the turn still gets its trust answer').toContain('configuration-marker-launch-folder');
  } finally { rmSync(key('arm-launch'), { force: true }); }
}, 120_000);

// 1.0.24 S03 (Opus self-review r5 H1): the ACP launch's automatic-choice checks resolved the turn's folder (canonicalFolder(cwd)) and
// asked whether the key is unrecordable (a realpath of the key and the home) live, on every launch and every engine request.
it('the ACP launch resolves the turn folder once, off the serving thread', async () => {
  const value = await bot(key('realcwd-folder'));
  writeFileSync(key('arm-realcwd'), '');
  try {
    const turn = await turnGap(value);
    expect(turn.worst, `the loop went unanswered ${turn.worst} ms inside one blocked call`).toBeLessThan(SLOW_MS / 3);
    expect(existsSync(key('realcwd.log')) ? readFileSync(key('realcwd.log'), 'utf8') : '', 'the launch resolved the folder with a synchronous file call').toBe('');
    expect(JSON.stringify(turn.messages), 'the turn still gets its trust answer').toContain('configuration-marker-realcwd-folder');
  } finally { rmSync(key('arm-realcwd'), { force: true }); }
}, 120_000);

// 1.0.24 S03 (Astra + Opus d66f84912c High): the automatic reply read the engine trust file's identity from the LAST stat, taken before the
// engine asked, so a "no" written to that file after the turn's trust step was missed and the reply granted the folder. The engine here
// writes that "no" just before it asks (FAKE_ACP_TRUST_DECLINE_*): nothing may grant the folder on the stale answer.
it('a decline written to the engine trust file after the turn step is never answered with a grant', async () => {
  const value = await bot(key('decline-folder'));
  const turn = await turnGap(value);
  const wire = readFileSync(key('wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const asked = wire.filter(entry => entry.event === 'request' && entry.params?.workspace === key('decline-folder'));
  expect(asked.length, 'the engine asked about the folder after the decline was written').toBeGreaterThan(0);
  const replies = wire.filter(entry => entry.event === 'reply' && asked.some(request => request.pid === entry.pid)).map(entry => JSON.parse(entry.raw).result);
  expect(replies.filter(result => result?.outcome === 'trust'), 'the reply granted the folder from the stat taken before the decline').toEqual([]);
  // and the ask is answered closed, not dropped: a reject reply, or the turn ends on a visible error row because the fresh stat moved the
  // trust epoch (the reply's own pre-check refuses to send, and the engine closes as folder-trust-undecided)
  const closed = turn.messages.some((message: any) => message.tool?.ok === false && /could not reply this time/.test(message.tool?.name ?? ''))
    && output.includes('reason=folder-trust-undecided');
  expect(replies.some(result => result?.outcome === 'reject') || closed, `the ask was neither rejected nor closed on the changed settings: ${JSON.stringify(replies)}`).toBe(true);
}, 120_000);

// 1.0.24 S03 (Astra 1afc268eb5 High): the fresh stat an automatic reply waits for was dropped when ANOTHER turn replayed its trust step
// from a snapshot stat taken before the decline (the replay marked every stat started so far as landed), so the reply answered from the
// old identity and granted. Here turn B's snapshot stat of the engine trust file is taken first and its answer held; turn A's engine writes
// the decline and asks; while A's fresh stat is in flight, B's trust step replays its old stat; then A's stat lands. Background identity
// refreshes and any later reply's refresh (turn B's own ask) are held until A's reply is sent, so A's answer rests on its own fresh stat alone.
it('another turn replaying a trust-file stat from before the decline does not drop the reply\'s fresh stat', async () => {
  const other = await bot(key('race-other')), value = await bot(key('race-folder'));
  // turns ran on this engine home before: its trust file is parsed and known (the cache state of any app that served a turn; the first
  // turn after the file changed starts the parse, so its answer is still unknown)
  await turnGap(other);
  expect(JSON.stringify((await turnGap(other)).messages), 'turn B gets its folder configuration from the parsed trust file').toContain('configuration-marker-race-other');
  const gateLog = (gate: string) => existsSync(key(`gate-${gate}.log`)) ? readFileSync(key(`gate-${gate}.log`), 'utf8') : '';
  const asksFor = (folder: string) => existsSync(key('wire.jsonl')) ? readFileSync(key('wire.jsonl'), 'utf8').trim().split('\n').filter(line => line && JSON.parse(line).event === 'request' && JSON.parse(line).params?.workspace === folder).length : 0;
  const idle = async (id: string) => expect.poll(async () => (await request('GET', '/api/bots?messages=0')).body.bots.find((entry: any) => entry.id === id)?.busy, { timeout: 40_000, message: output.slice(-2000) }).toBe(false);
  try {
    const otherAsks = asksFor(key('race-other'));
    writeFileSync(key('arm-SNAP'), '');
    expect((await request('POST', `/api/bots/${other.id}/messages`, { threadId: other.threadId, text: 'go' })).status).toBe(202);
    await expect.poll(() => gateLog('SNAP'), { timeout: 20_000, message: 'turn B never statted the trust file in its snapshot' }).toContain('held SNAP');
    writeFileSync(key('arm-REFRESH'), ''); writeFileSync(key('arm-BACKGROUND'), '');
    expect((await request('POST', `/api/bots/${value.id}/messages`, { threadId: value.threadId, text: 'go' })).status).toBe(202);
    await expect.poll(() => gateLog('REFRESH'), { timeout: 30_000, message: 'turn A\'s reply never started its fresh stat' }).toContain('held REFRESH');
    writeFileSync(key('release-SNAP'), '');
    // turn B replays its trust step from the snapshot taken before the decline; its engine asks only after that replay (its own reply's
    // refresh is then held by BACKGROUND), so B's ask on the wire is the point where the replay has happened
    await expect.poll(() => asksFor(key('race-other')), { timeout: 30_000, message: 'turn B never got past its trust step' }).toBeGreaterThan(otherAsks);
    writeFileSync(key('release-REFRESH'), '');
    await idle(value.id);
  } finally { for (const gate of ['SNAP', 'REFRESH', 'BACKGROUND']) writeFileSync(key(`release-${gate}`), ''); }
  await idle(other.id);
  const wire = readFileSync(key('wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const asked = wire.filter(entry => entry.event === 'request' && entry.params?.workspace === key('race-folder'));
  expect(asked.length, 'turn A\'s engine asked about the folder after the decline was written').toBeGreaterThan(0);
  const replies = wire.filter(entry => entry.event === 'reply' && asked.some(request => request.pid === entry.pid)).map(entry => JSON.parse(entry.raw).result);
  expect(replies.filter(result => result?.outcome === 'trust'), 'the reply granted the folder: its fresh stat was dropped for the other turn\'s older one').toEqual([]);
  // answered closed, not dropped: a reject reply, or turn A ends on a visible error row (its fresh stat moved the trust epoch)
  const messages = (await request('GET', `/api/threads/${value.threadId}/messages?limit=200`)).body.messages as any[];
  const closed = messages.some((message: any) => message.tool?.ok === false && /could not reply this time/.test(message.tool?.name ?? ''));
  expect(replies.some(result => result?.outcome === 'reject') || closed, `the ask was neither rejected nor closed: ${JSON.stringify(replies)}`).toBe(true);
}, 180_000);
