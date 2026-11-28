// Isolated real server assembly + ACP launcher/seed/wire fixture. Actual shipped
// engine/provider/OS qualification remains MAIN's separate required packet.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FolderTrustStore } from './folder-trust.ts';
import { productionAdmittedInstance } from './testing/admission-fence.ts';
import { fakeEngineServerArgs } from './testing/fake-engine-server.ts';
import { freePortBlock } from './testing/ports.ts';
import { removeTempDir, waitForExit } from './testing/cleanup.ts';

const serverDir = dirname(fileURLToPath(import.meta.url)), cli = join(serverDir, 'testing/fake-acp-cli.ts');
let root: string, base: string, child: ChildProcess | undefined, headers: Record<string, string>, output = '';
const companionToken = randomBytes(32).toString('hex');
const key = (name: string) => join(root, name);
const request = async (method: string, path: string, body?: unknown, authority = headers) => {
  const response = await fetch(base + path, { method, headers: { ...authority, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as any };
};
const records = () => readFileSync(key('.murage/folder-trust.json'), 'utf8');
const wire = () => existsSync(key('wire.jsonl')) ? readFileSync(key('wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'trust-primary-api-')));
  chmodSync(cli, 0o755);
  mkdirSync(key('.murage')); mkdirSync(key('.fuigo'));
  writeFileSync(key('.fuigo/auth.json'), '{}');
  for (const name of ['picked', 'declined', 'unpicked', 'another-key', 'own-declined', 'restart']) {
    mkdirSync(key(name)); writeFileSync(join(key(name), 'AGENTS.md'), `configuration-marker-${name}`);
  }
  const saved = new FolderTrustStore(key('.murage/folder-trust.json'));
  saved.remember(key('declined'), 'reject', 'card', { key: key('declined'), consent: 2 });
  mkdirSync(key('page-folder'));
  saved.remember(key('page-folder'), 'trust', 'picker');
  for (let n = 0; n < 121; n++) saved.remember(key(`page-other-${n}`), 'reject', 'card', { key: key(`page-other-${n}`), consent: 2 });
  // A home grant must not preload a folder Murage declined.
  writeFileSync(key('.fuigo/trusted_folders.toml'), `[folders.${JSON.stringify(key('declined'))}]\ntrusted = true\nconsent = 2\n\n[folders.${JSON.stringify(key('own-declined'))}]\ntrusted = false\nconsent = 2\n`);
  const engine = (other = false, command?: string) => ({ driver: 'fuigoAgent', environment: { FAKE_ACP_VERSION: '1.0.62', FAKE_ACP_MODE: 'folder-trust', FAKE_ACP_TRUST_V: '2', FAKE_ACP_MCP_READY: '1', FAKE_ACP_TRUST_LOG: key('wire.jsonl'), ...(other ? { FAKE_ACP_TRUST_WORKSPACE: key('another-key') } : {}), ...(command ? { FAKE_ACP_TRUST_THEN_COMMAND: command } : {}) }, config: { cli, fullAuto: false } });
  // W-T18: after the trust reply the engine asks to run one command, a wipe or an ordinary one
  writeFileSync(key('.murage/config.json'), JSON.stringify({ defaultModel: { instanceId: 'fixture', model: 'fake-acp-model' }, instances: { fixture: engine(), second: engine(), other: engine(true), wipe: engine(false, 'rm -rf ~'), harmless: engine(false, 'echo fixture-command'), computer: { driver: 'boxAgent' } } }));
  mkdirSync(key('.murage/run/fuigo-turn-homes/previous-epoch'), { recursive: true });
  writeFileSync(key('.murage/run/fuigo-turn-homes/previous-epoch/auth.json'), '{}');
  await bootServer();
  expect((await request('POST', '/api/memory/action', { action: 'configure', mode: 'off' })).status).toBe(200);
  expect((await request('POST', '/api/no-limits/terms', { acknowledgeNoLimits: true })).status).toBe(200);
}, 45_000);
afterAll(async () => { if (child) await waitForExit(child, { signal: 'SIGTERM' }); if (root) await removeTempDir(root); });

async function bootServer() {
  const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, fakeEngineServerArgs(join(serverDir, 'index.ts')), { cwd: join(serverDir, '..'), windowsHide: true,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, NODE_ENV: 'test', MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: '1', MURAGE_ACP_POOL: '1', MURAGE_COMPANION_TOKEN: companionToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', bytes => { output += bytes; }); child.stderr?.on('data', bytes => { output += bytes; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Isolated fixture failed to start: ' + output.slice(-4000));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const proof = await fetch(base + '/api/desktop-secret').then(response => response.json()) as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}

async function bot(folder: string, instanceId = 'fixture') {
  const created = await request('POST', '/api/bots', { name: 'Trust fixture', modelSelection: { instanceId, model: 'fake-acp-model' } });
  expect(created.status).toBe(201); const value = created.body.bot;
  expect((await request('PATCH', `/api/bots/${value.id}`, { autoApprove: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const review = await request('POST', `/api/bots/${value.id}/permissions/refresh`, { scope: 'open', targetLevel: 'no-limits' });
  const saved = await request('PATCH', `/api/bots/${value.id}`, { settingsScope: 'defaults', previewId: review.body.previewId, ifRev: review.body.botRev, fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true });
  expect(saved.status).toBe(200);
  expect((await request('POST', `/api/bots/${value.id}/permissions/refresh`, { scope: 'open', rosterId: review.body.rosterId, targetLevel: review.body.targetLevel, afterRev: saved.body.bot?.permissionRev ?? saved.body.permissionRev })).status).toBe(200);
  expect((await request('PATCH', `/api/bots/${value.id}`, { cwd: folder })).status).toBe(200);
  return value as { id: string; threadId: string };
}
async function turn(value: { id: string; threadId: string }) {
  expect((await request('POST', `/api/bots/${value.id}/messages`, { threadId: value.threadId, text: 'go' })).status).toBe(202);
  await expect.poll(async () => (await request('GET', '/api/bots?messages=0')).body.bots.find((entry: any) => entry.id === value.id)?.busy, { timeout: 30_000, message: output.slice(-2000) }).toBe(false);
  return (await request('GET', `/api/threads/${value.threadId}/messages?limit=200`)).body.messages as any[];
}
it('W-T15 server boot sweeps prior-epoch isolated credential homes before the first turn', () => {
  expect(existsSync(key('.murage/run/fuigo-turn-homes/previous-epoch'))).toBe(false);
});

it('T-TRUST-C1/H2-api-picked: real assembly preserves stores, sends process duration, loads only picked configuration and retires the process', async () => {
  const value = await bot(key('picked')), before = records(), own = readFileSync(key('.fuigo/trusted_folders.toml'), 'utf8');
  const messages = await turn(value);
  expect(JSON.stringify(messages)).toContain('configuration-marker-picked');
  expect(messages.filter(message => message.card?.folderTrust)).toEqual([]);
  const first = wire().filter(event => event.event === 'request' && event.params?.workspace === key('picked')).at(-1);
  expect(first).toBeDefined();
  expect(JSON.parse(wire().filter(event => event.event === 'reply' && event.pid === first.pid).at(-1).raw).result).toEqual({ outcome: 'trust', scope: 'configAndCommands', duration: 'process' });
  expect(records()).toBe(before); expect(readFileSync(key('.fuigo/trusted_folders.toml'), 'utf8')).toBe(own);
  const status = await request('GET', `/api/folder-trust?bot=${value.id}&thread=${value.threadId}`);
  expect(status.body.lastObserved?.kind).toBe('process-choice-sent');
  expect(status.body.destination).toBe('per-turn-local-home');
  expect(status.body.upstreamStore).toBe('temporary');
  expect(status.body.upstreamTrustFile).toBeNull();
  await turn(value);
  expect(wire().filter(event => event.event === 'request' && event.params?.workspace === key('picked')).at(-1).pid).not.toBe(first.pid);
});
it.each(['declined', 'unpicked'])('T-TRUST-C1-api-%s: own-home decoys cannot bypass current configuration eligibility', async name => {
  const value = await bot(key(name), name === 'unpicked' ? 'other' : 'fixture'), before = records();
  const messages = await turn(value);
  expect(JSON.stringify(messages)).toContain('agents: withheld');
  expect(JSON.stringify(messages)).not.toContain(`configuration-marker-${name}`);
  expect(messages.filter(message => message.card?.folderTrust)).toEqual([]);
  const asked = name === 'unpicked' ? key('another-key') : key(name);
  const event = wire().filter(entry => entry.event === 'request' && entry.params?.workspace === asked).at(-1);
  expect(event).toBeDefined();
  expect(JSON.parse(wire().filter(entry => entry.event === 'reply' && entry.pid === event.pid).at(-1).raw).result).toEqual({ outcome: 'reject' });
  expect(records()).toBe(before);
});
// W-T18, server half: the configuration reject at owner No limits leaves the owner decision layer as it was.
// The wipe still opens exactly one command card (answered Don't allow); an ordinary command runs with no card.
it.each(['wipe', 'harmless'])('wipe-still-cards-under-owner-no-limits-after-reject (W-T18 server half: %s)', async instanceId => {
  const value = await bot(key('declined'), instanceId), before = records(), from = wire().length;
  const listed = async () => (await request('GET', `/api/threads/${value.threadId}/messages?limit=200`)).body.messages as any[];
  const commandCards = async () => (await listed()).filter(message => message.card?.requestHandle && !message.card.folderTrust);
  expect((await request('POST', `/api/bots/${value.id}/messages`, { threadId: value.threadId, text: 'go' })).status).toBe(202);
  const busy = async () => (await request('GET', '/api/bots?messages=0')).body.bots.find((entry: any) => entry.id === value.id)?.busy;
  if (instanceId === 'wipe') {
    await expect.poll(async () => (await commandCards()).length, { timeout: 30_000, message: output.slice(-2000) }).toBe(1);
    const [card] = await commandCards();
    expect(JSON.stringify(card)).not.toContain('folderTrust');
    expect((await request('POST', `/api/threads/${value.threadId}/respond`, { requestHandle: card.card.requestHandle, action: 'deny' })).status).toBe(200);
  }
  await expect.poll(busy, { timeout: 30_000, message: output.slice(-2000) }).toBe(false);
  const events = wire().slice(from);
  const asked = events.filter(event => event.event === 'request' && event.params?.workspace === key('declined')).at(-1);
  expect(asked).toBeDefined();
  expect(JSON.parse(events.filter(event => event.event === 'reply' && event.pid === asked.pid).at(-1).raw).result, 'the folder configuration stays withheld').toEqual({ outcome: 'reject' });
  const replies = events.filter(event => event.event === 'command-reply' && event.pid === asked.pid).map(event => JSON.parse(event.raw).result?.outcome);
  expect(replies, 'the command decision reaches the engine').toEqual([expect.objectContaining({ optionId: instanceId === 'wipe' ? 'reject-once' : 'allow-once' })]);
  const messages = await listed();
  expect(messages.filter(message => message.card?.folderTrust), 'the configuration reject itself asks nothing').toEqual([]);
  expect(await commandCards(), instanceId === 'wipe' ? 'only the wipe asks' : 'an ordinary command never asks at No limits').toHaveLength(instanceId === 'wipe' ? 1 : 0);
  expect(JSON.stringify(messages)).toContain('agents: withheld');
  expect(JSON.stringify(messages)).not.toContain('configuration-marker-declined');
  expect(records()).toBe(before);
});
it('T-TRUST-F03-native-no: a proven own-store decline is reported once after a rejected configuration reply', async () => {
  const value = await bot(key('own-declined'));
  expect((await request('DELETE', `/api/folder-trust?key=${encodeURIComponent(key('own-declined'))}`)).status).toBe(200);
  const first = await turn(value);
  expect(JSON.stringify(first)).toContain('agents: withheld');
  expect(JSON.stringify(first)).not.toContain('configuration-marker-own-declined');
  expect(first.filter(message => message.tool?.name === 'folder stored no:')).toHaveLength(1);
  const second = await turn(value);
  expect(second.filter(message => message.tool?.name === 'folder stored no:')).toHaveLength(1);
});
it('T-TRUST-F08-on-path: the selected folder stays on the first page ahead of unrelated declines', async () => {
  const page = await request('GET', `/api/folder-trust?folder=${encodeURIComponent(key('page-folder'))}`);
  expect(page.status).toBe(200);
  expect(page.body.records[0].key).toBe(key('page-folder'));
  expect(page.body.records[0].onPath).toBe(true);
  expect(page.body.records).toHaveLength(50);
  expect(page.body.recordsNext).toEqual(expect.any(String));
});
it('W-T17 phone-and-channel-get-no-records, including an authenticated phone and unproved desktop header', async () => {
  const phone = { 'x-murage-companion': '1', 'x-murage-companion-token': companionToken };
  expect((await request('GET', '/api/bots?messages=0', undefined, phone)).status).toBe(200);
  const authorities: Record<string, string>[] = [{}, { 'x-murage-surface': 'desktop' }, { 'x-murage-companion': '1', 'x-murage-companion-token': companionToken }];
  for (const authority of authorities) {
    const response = await request('GET', `/api/folder-trust?folder=${encodeURIComponent(key('picked'))}`, undefined, authority);
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(key('declined'));
  }
});

it.each(['fixture', 'second'])('W-T20 settings-reports-last-turn-across-subject-change (%s)', async instanceId => {
  const first = await bot(key('picked'));
  await turn(first);
  const query = (value: { id: string; threadId: string }) => `/api/folder-trust?bot=${value.id}&thread=${value.threadId}`;
  expect((await request('GET', query(first))).body.lastObserved?.kind).toBe('process-choice-sent');
  const second = await bot(key('picked'));
  await turn(second);
  const unpicked = key(`.murage/workspaces/${second.id}/threads/${second.threadId}`);
  mkdirSync(unpicked, { recursive: true });
  writeFileSync(join(unpicked, 'AGENTS.md'), 'configuration-marker-unpicked-desk');
  expect((await request('PATCH', `/api/bots/${second.id}/tasks/${second.threadId}`, { cwd: null, modelSelection: { instanceId, model: 'fake-acp-model' } })).status).toBe(200);
  const beforeTurn = (await request('GET', query(second))).body;
  expect(beforeTurn.lastObserved?.kind, 'a previous key cannot publish a process choice into B').not.toBe('process-choice-sent');
  await turn(second);
  const withheld = (await request('GET', query(second))).body;
  expect(withheld.lastObserved?.kind).toBe('configuration-withheld');
  expect(withheld.lastObserved?.reason).toBe('not-picked');
  expect(withheld.lastObserved?.kind).not.toBe('process-choice-sent');
  expect((await request('GET', query(first))).body.lastObserved?.kind).toBe('process-choice-sent');
  expect((await request('GET', `/api/folder-trust?bot=${second.id}&thread=${first.threadId}`)).status).toBe(404);
  // Changing saved choices must not erase a successful observation from the last turn.
  expect((await request('DELETE', `/api/folder-trust?key=${encodeURIComponent(key('picked'))}`)).status).toBe(200);
  expect((await request('GET', query(first))).body.lastObserved?.kind).toBe('process-choice-sent');
});
it('W-T22 cloud-turn-settings-destination-cloud-home, with native own-home control', async () => {
  const value = await bot(key('picked'));
  const query = `/api/folder-trust?bot=${value.id}&thread=${value.threadId}`;
  const cloud = await request('GET', query + '&runOn=cloud');
  expect(cloud.status).toBe(200);
  expect(cloud.body.destination).toBe('cloud-home');
  expect(cloud.body.upstreamTrustFile).toBeNull();
  expect(cloud.body.upstreamTrusted).toBe(false);
  expect(cloud.body.upstreamDeclines).toEqual([]);
  expect(cloud.body.observedVersion).toBe('unknown');
  expect((await request('GET', query)).body.destination).toBe('per-turn-local-home');
});

it('W-T21 restart-reasks-and-settings-keeps-history with no saved trust record', async () => {
  const value = await bot(key('restart'));
  expect((await request('PATCH', `/api/bots/${value.id}/tasks/${value.threadId}`, { cwd: key('restart') })).status).toBe(200);
  expect((await request('DELETE', `/api/folder-trust?key=${encodeURIComponent(key('restart'))}`)).status).toBe(200);
  const before = records(), own = readFileSync(key('.fuigo/trusted_folders.toml'), 'utf8');
  try { await turn(value); }
  finally {
    expect(records(), 'automatic choices preserve saved-store bytes even if transport fails').toBe(before);
    expect(readFileSync(key('.fuigo/trusted_folders.toml'), 'utf8')).toBe(own);
  }
  const query = `/api/folder-trust?bot=${value.id}&thread=${value.threadId}`;
  const first = wire().filter(event => event.event === 'request' && event.params?.workspace === key('restart')).at(-1);
  expect(first).toBeDefined();
  const history = (await request('GET', query)).body;
  expect(history.lastObserved?.kind).toBe('process-choice-sent');
  expect(history.record).toBeNull();
  expect(history.records.some((record: { key: string }) => record.key === key('restart'))).toBe(false);
  expect(records()).toBe(before);
  expect(readFileSync(key('.fuigo/trusted_folders.toml'), 'utf8')).toBe(own);
  await waitForExit(child!, { signal: 'SIGKILL' }); child = undefined;
  await bootServer();
  const restarted = (await request('GET', query)).body;
  expect(restarted.lastObserved).toEqual(history.lastObserved);
  expect(restarted.record).toBeNull();
  await turn(value);
  const second = wire().filter(event => event.event === 'request' && event.params?.workspace === key('restart')).at(-1);
  expect(second.pid).not.toBe(first.pid);
  expect(JSON.parse(wire().filter(event => event.event === 'reply' && event.pid === second.pid).at(-1).raw).result).toEqual({ outcome: 'trust', scope: 'configAndCommands', duration: 'process' });
  expect(records()).toBe(before);
  expect(readFileSync(key('.fuigo/trusted_folders.toml'), 'utf8')).toBe(own);
});

it('W-T12 cloud-unrouted-settings-reads-no-local-decoy, with native source control', () => {
  const source = readFileSync(join(serverDir, 'index.ts'), 'utf8');
  const start = source.indexOf('function turnRouting('), end = source.indexOf('\n// ──', start);
  const native = { instanceId: 'native', driverKind: 'fuigoAgent', adapter: { capabilities: { folderTrust: true } } };
  const cloud = { instanceId: 'cloud', driverKind: 'boxAgent', adapter: { capabilities: {} } };
  // O1 m2 S1a D1.6: turnRouting reads a local engine through the real admission fence, compiled over this registry
  const registry = { instances: () => [native, cloud], get: () => native };
  const context = { registry, admittedInstance: productionAdmittedInstance(registry), isCloudHome: () => false, selectedProviderRoute: () => undefined };
  const route = (runOn?: string) => runInNewContext(ts.transpileModule(source.slice(start, end) + `; turnRouting({modelSelection:{instanceId:"native"}}, ${JSON.stringify(runOn) ?? 'undefined'})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const api = source.indexOf('if (path === "/api/folder-trust"');
  const readStart = source.indexOf('      const engineGates =', api), readEnd = source.indexOf('      if (method === "POST")', readStart);
  const local = vi.fn(() => '/fixture/local-decoy');
  const scan = vi.fn((_cwd: string, _options: { fuigoHome: string | null }) => ({ key: '/fixture/workspace' }));
  const prepare = vi.fn();
  const read = (routing: ReturnType<typeof route>) => runInNewContext(ts.transpileModule(source.slice(readStart, readEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { destination: routing.trustDestination, fuigoInstance: routing.instance, checked: { cwd: '/fixture/workspace' }, fuigoHomeForTrust: local, scanFolderTrustSources: scan, upstreamTrustForTurn: prepare });
  // the local route resolves its engine through the production admission fence (index.ts admittedInstance)
  const admitted = (() => { try { return route().instance; } catch (error) { return String((error as { message?: unknown }).message); } })();
  expect(admitted, 'the open admission fence admits the local Fuigo engine at turnRouting').toBe(native);
  const routed = route('cloud');
  expect(routed.providerRoute).toBeUndefined();
  expect(routed.trustDestination).toBe('cloud-home');
  read(routed);
  expect(local, 'Cloud Settings must do zero local-home reads').not.toHaveBeenCalled();
  expect(scan.mock.calls[0][1].fuigoHome).toBeNull();
  expect(prepare, 'Cloud Settings must not prepare a local upstream store').not.toHaveBeenCalled();
  read(route());
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(local).toHaveBeenCalledTimes(1);
  expect(scan.mock.calls[1][1].fuigoHome).toBe('/fixture/local-decoy');
  // O1 m2 S1a D1.6: the bound fence is production's own, so an unresolved custody record refuses this local Fuigo engine here
  const closed = { ...context, admittedInstance: productionAdmittedInstance(registry, 1), unavailableModelMessage: (id: string) => `unavailable ${id}` };
  const refusal = (() => { try { runInNewContext(ts.transpileModule(source.slice(start, end) + '; turnRouting({modelSelection:{instanceId:"native"}})', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, closed); return 'admitted'; } catch (error) { return String((error as { message?: unknown }).message); } })();
  expect(refusal, 'a closed admission fence admits no local Fuigo engine at turnRouting').toBe('unavailable native');
});

it('Settings never transplants a same-key observation to a different engine instance', async () => {
  const value = await bot(key('picked'));
  await turn(value);
  const query = `/api/folder-trust?bot=${value.id}&thread=${value.threadId}`;
  expect((await request('GET', query)).body.lastObserved?.kind).toBe('process-choice-sent');
  expect((await request('PATCH', `/api/bots/${value.id}/tasks/${value.threadId}`, { modelSelection: { instanceId: 'other', model: 'fake-acp-model' } })).status).toBe(200);
  const changed = (await request('GET', query)).body;
  expect(changed.instanceId).toBe('other');
  expect(changed.lastObserved).toBeNull();
  expect(changed.observedVersion).toBe('unknown');
});

it('a Trust mutation returns its saved result independently of a stale list cursor', async () => {
  const value = await bot(key('unpicked'));
  const before = wire().length;
  const response = await request('POST', '/api/folder-trust?cursor=invalid', { bot: value.id, thread: value.threadId });
  expect(response.status).toBe(200);
  expect(response.body.record).toMatchObject({ key: key('unpicked'), decision: 'trust' });
  // R2 (ruled D1): only a generation-2 card answer stamps consent 2; a Settings Trust never does
  expect(response.body.record).not.toHaveProperty('consent');
  expect(JSON.parse(records()).folders[key('unpicked')]).toMatchObject({ decision: 'trust' });
  expect(JSON.parse(records()).folders[key('unpicked')]).not.toHaveProperty('consent');
  expect(response.body.records).toHaveLength(50);
  expect(wire()).toHaveLength(before);
});

it('the assembly source revision changes when an unknown upstream cache becomes readable or declined', () => {
  const source = readFileSync(join(serverDir, 'index.ts'), 'utf8');
  const start = source.indexOf('function folderTrustForTurn('), end = source.indexOf('/** Full access with', start);
  const snapshot = { revision: 'saved-revision', seedComplete: true, lookup: () => ({ picked: true }) };
  const upstream = { readable: false, declined: false, revision: 'same-file-identity' };
  const context = { createHash, folderTrust: { readable: true, snapshot: () => snapshot, decision: () => undefined }, fuigoHomeForTrust: () => null,
    folderTrustKeyForTurn: () => '/fixture/workspace', upstreamTrustForTurn: () => upstream, upstreamTrustNow: () => upstream,
    scanFolderTrustSources: () => ({ key: '/fixture/workspace', folder: '/fixture/workspace', sources: [] }),
    isUnrecordableTrustRoot: () => false, noCardPickFields: () => ({}) };
  const gate = runInNewContext(ts.transpileModule(source.slice(start, end) + '; folderTrustForTurn({adapter:{capabilities:{folderTrust:true}}},"/fixture/workspace",false)', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const unknown = gate.sourceNow();
  expect(unknown.readable).toBe(false);
  upstream.readable = true;
  const readable = gate.sourceNow();
  expect(readable.revision).not.toBe(unknown.revision);
  upstream.declined = true;
  const declined = gate.sourceNow();
  expect(declined.revision).not.toBe(readable.revision);
  expect(declined.declined).toBe(true);
});
it('the assembly authority consumes K15-0 eligibility and revokes on selected account changes', () => {
  const source = readFileSync(join(serverDir, 'index.ts'), 'utf8');
  const start = source.indexOf('function folderConfigurationAuthorityNow('), end = source.indexOf('async function changeDecisionLevel(', start);
  let eligible = true, account = 'first-account';
  const context = { createHash, trustOriginNow: () => ({ kind: eligible ? 'owner-direct' : 'ineligible', noLimits: eligible, authorityGeneration: 'generation', level: 'unlimited' }),
    store: { bot: () => ({ modelSelection: { instanceId: 'fixture', model: 'fixture-model' } }), taskByThread: () => ({ cwd: '/fixture/workspace', cwdOwnerSet: true }) },
    folderTrust: { snapshot: () => ({ revision: 'saved-revision' }) }, cfg: {}, instanceConfigs: () => ({ fixture: { account } }) };
  const read = () => runInNewContext(ts.transpileModule(source.slice(start, end) + '; folderConfigurationAuthorityNow("thread","generation","bot")', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const first = read(); expect(first.owner).toBe(true);
  account = 'second-account'; expect(read().revision).not.toBe(first.revision);
  eligible = false; expect(read().owner).toBe(false);
});
