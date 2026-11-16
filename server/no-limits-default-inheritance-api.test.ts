// SPDX-License-Identifier: AGPL-3.0-or-later
// Real server, isolated launcher and inert native engine. No command executes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';

for (const inherited of [false, true]) describe(`G-NL real dispatch: ${inherited ? 'inherited default' : 'explicit bot'} No limits`, () => {
  let fixture: VerificationServer, headers: Record<string, string>, model: string;
  async function api(method: string, path: string, body?: unknown, auth = headers) {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true,
      instrumentationSource: `
        const fs=await import('node:fs'),path=await import('node:path');
        process.env.FAKE_TELEGRAM_DIR=path.join(process.env.MURAGE_DATA_DIR,'telegram');
        fs.mkdirSync(process.env.FAKE_TELEGRAM_DIR);
        await import(path.join(process.cwd(),'server/testing/telegram-fetch-preload.mjs'));
        process.env.MURAGE_GATE_TAP='1';
        process.env.FAKE_CLAUDE_PERM_TOOL='Bash';
        process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command:'cat .env'});
        // Webhook/channel envelopes put metadata after the message. This inert
        // fake must request its permission tool even when the marker is wrapped.
        const {pathToFileURL}=await import('node:url');
        const originalCli=path.join(process.cwd(),'server/testing/fake-claude-cli.ts');
        const cli=path.join(process.env.MURAGE_DATA_DIR,'permission-fixture.ts');
        let source=fs.readFileSync(originalCli,'utf8');
        const marker='fixtureRequested(promptText(prompt), "__fixture_permission_tool__")';
        if(!source.includes(marker))throw Error('Permission fixture marker moved');
        source=source.replace(marker,'promptText(prompt).includes("__fixture_permission_tool__")');
        source=source.replace(/from "([.][^"\\n]+)"/g,(_match,specifier)=>'from '+JSON.stringify(new URL(specifier,pathToFileURL(originalCli)).href));
        fs.writeFileSync(cli,source);fs.chmodSync(cli,0o755);
        const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json');
        const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
        config.instances.verification.config.cli=cli;
        fs.writeFileSync(configFile,JSON.stringify(config));
      ` });
    headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret', undefined, {})).body.secret };
    expect(await runControlMurage(['doctor', '--url', fixture.info.url])).toMatchObject({ ok: true });
    // This fixture checks permissions, with optional recall disabled through the owner API.
    expect((await api('POST', '/api/memory/action', { action: 'configure', mode: 'off' })).status).toBe(200);
    model = (await api('GET', '/api/instances')).body.instances.find((row: any) => row.instanceId === 'verification').models.options[0].id;
    if (inherited) expect((await api('PATCH', '/api/config', { newBots: { permissionLevel: 'no-limits' }, acknowledgeNoLimits: true })).status).toBe(200);
  }, 120000);
  afterAll(async () => { await fixture?.close(); });
  async function makeBot(name: string) {
    const made = await api('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } });
    expect(made.status).toBe(201);
    const bot = made.body.bot;
    expect((await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' })).status).toBe(200);
    if (!inherited) expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    else expect((await api('GET', `/api/bots/${bot.id}`)).body.bot.permissionExplicit).not.toBe(true);
    return bot;
  }
  async function messages(threadId: string) { return (await api('GET', `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[]; }
  async function permissionRuns(botId: string, threadId: string) {
    let outcome = 'waiting';
    await expect.poll(async () => {
      const rows = await messages(threadId);
      outcome = rows.some(row => row.text === 'permission: allowed') ? 'allowed' : rows.some(row => row.kind === 'options' && row.card?.requestHandle) ? 'card' : 'waiting';
      return outcome;
    }, { timeout: 30000 }).not.toBe('waiting');
    expect(outcome).toBe('allowed');
    expect((await messages(threadId)).filter(row => row.kind === 'options' && row.card)).toHaveLength(0);
    console.info(`G-NL WORKFLOW ${inherited ? 'inherited' : 'explicit'} ${botId ? 'bot' : ''}: allowed, cards=0`);
  }
  async function runThread(runId: string) {
    let threadId: string | undefined;
    await expect.poll(async () => {
      threadId = (await api('GET', '/api/routines')).body.runs.find((row: any) => row.id === runId)?.threadId;
      return threadId;
    }, { timeout: 15000 }).toBeTruthy();
    return threadId!;
  }
  it('a routine run inherits No limits without a non-wipe card', async () => {
    const bot = await makeBot('Routine fixture');
    const made = await api('POST', '/api/routines', { botId: bot.id, name: 'Routine fixture', prompt: '__fixture_permission_tool__', runOn: 'ember', enabled: false,
      schedule: { type: 'interval', everyMinutes: 60, anchorAt: Date.now() + 3600000 } });
    expect(made.status).toBe(201);
    const started = await api('POST', `/api/routines/${made.body.routine.id}/run`, {});
    expect(started.status).toBe(201);
    await permissionRuns(bot.id, await runThread(started.body.run.id));
  }, 60000);
  it('a webhook-triggered run inherits No limits without a non-wipe card', async () => {
    const bot = await makeBot('Webhook fixture');
    const made = await api('POST', '/api/webhooks', { botId: bot.id, name: 'Webhook fixture', prompt: '__fixture_permission_tool__', runOn: 'ember' });
    expect(made.status).toBe(201);
    const response = await fetch(made.body.credential.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'fixture' }) });
    expect(response.status).toBe(202);
    await permissionRuns(bot.id, await runThread((await response.json() as any).runId));
  }, 60000);
  it('a bot-created seat inherits its No limits creator without a non-wipe card', async () => {
    const parent = await makeBot('Team lead fixture');
    expect((await api('PATCH', `/api/bots/${parent.id}`, { chiefOfStaff: true, section: 'Fixture team' })).status).toBe(200);
    expect((await api('POST', `/api/bots/${parent.id}/messages`, { threadId: parent.threadId, text: '__fixture_hold_authority__ seat-fixture' })).status).toBe(202);
    try {
      let token: string | undefined;
      await expect.poll(() => {
        try {
          const line = readFileSync(fixture.fixtureDumpLogPath, 'utf8').split('\n').find(row => row.includes('seat-fixture'));
          if (line) token = withTurnSecrets(JSON.parse(line)).mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;
        } catch { /* dump not written yet */ }
        return !!token;
      }, { timeout: 30000 }).toBe(true);
      const made = await api('POST', '/api/internal/create-bot', { fromBotId: parent.id, fromThreadId: parent.threadId, name: 'Created seat fixture', role: 'Specialist', instructions: 'Handle fixture work.' }, { authorization: 'Bearer ' + token });
      expect(made.status).toBe(201);
      const child = (await api('GET', '/api/bots')).body.bots.find((row: any) => row.name === 'Created seat fixture');
      expect(child).toBeTruthy();
      expect((await api('POST', `/api/bots/${child.id}/messages`, { threadId: child.threadId, text: '__fixture_permission_tool__' })).status).toBe(202);
      await permissionRuns(child.id, child.threadId);
    } finally { await api('POST', `/api/bots/${parent.id}/interrupt`, { threadId: parent.threadId }); }
  }, 60000);
  it('an owner turn from another channel inherits No limits without a non-wipe card', async () => {
    const bot = await makeBot('Channel fixture');
    expect((await api('PATCH', `/api/bots/${bot.id}`, { chiefOfStaff: true, chiefScope: 'workspace' })).status).toBe(200);
    const dir = join(fixture.info.dataDir, 'telegram'), updates: unknown[] = [];
    const arrive = (id: number, text: string) => {
      updates.push({ update_id: id, message: { message_id: id, date: 1700000000 + id, text, from: { id: 777, is_bot: false }, chat: { id: 777, type: 'private' } } });
      writeFileSync(join(dir, 'staged.json'), JSON.stringify(updates));
      renameSync(join(dir, 'staged.json'), join(dir, 'updates.json'));
    };
    expect((await api('PATCH', '/api/config', { telegram: { botToken: '123:abcdefghijklmnopqrstuvwxyz123456' } })).status).toBe(200);
    const pair = await api('POST', '/api/telegram/pair', { targetBotId: bot.id });
    expect(pair.status).toBe(200); arrive(1, '/pair ' + pair.body.code);
    await expect.poll(async () => (await api('GET', '/api/telegram/status')).body.paired, { timeout: 15000 }).toBe(true);
    const binding = (await api('POST', '/api/memory/action', { action: 'humans' })).body.bindings[0];
    expect((await api('POST', '/api/memory/action', { action: 'human-link', bindingId: binding.id, expectedRevision: binding.revision, as: 'owner' })).status).toBe(200);
    arrive(2, '__fixture_permission_tool__');
    let run: any;
    await expect.poll(async () => { run = (await api('GET', '/api/routines')).body.runs.find((row: any) => row.botId === bot.id && row.triggerSource === 'channel'); return run?.threadId; }, { timeout: 20000 }).toBeTruthy();
    await permissionRuns(bot.id, run.threadId);
  }, 60000);

});
