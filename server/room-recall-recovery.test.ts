// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2f (room preparation); consumer owner: warm-keep (native session contract).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, onTestFailed } from 'vitest';
import { launchMemoryVerificationServer } from './testing/memory-verification-fixture.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';

for (const engine of ['claude', 'acp'] as const) for (const recovery of ['held', 'readmitted'] as const) {
  it(`${engine}: room ${recovery} recovery replaces recalled context only when held`, async () => {
    const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
    const fixture = await launchMemoryVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const {registerHooks}=await import('node:module');
      registerHooks({load(url,context,next){
        const result=next(url,context);let source=String(result.source);
        if(url.endsWith('/server/index.ts')) {
          source=source.replace('const resetRoomMemberSession = async () => {','const resetRoomMemberSession = async () => {console.warn("fixture room reset");');
          const needle='const access=await admittedRecallAccess(recallReadiness,bot.id,threadId,internalGeneration);';
          source=source.replace(needle,\`if(latestUser?.text?.includes('Recover room') && globalThis.fixtureRecoveryMessage!==latestUser.id){
            globalThis.fixtureRecoveryMessage=latestUser.id;console.warn('fixture room recovery ${recovery}');
            ${recovery === 'held' ? 'await recallReadiness.access(()=>{throw new RecallPreparationPending();},new AbortController().signal);' : 'throw new RecallPreparationPending();'}
          }\`+needle);
        }
        return {...result,source};
      }});
      await import(${url('server/testing/fake-engine-env-preload.mjs')});
      await import(${url('server/testing/idle-load-preload.mjs')});
      process.env.MURAGE_TURN_TRACE='1';
      const fs=await import('node:fs'),path=await import('node:path');
      const {fileURLToPath}=await import('node:url');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
      if(${JSON.stringify(engine)}==='acp')config.instances.verification={driver:'grokAgent',config:{cli:fileURLToPath(${url('server/testing/fake-acp-cli.ts')})},environment:{FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'room-rpc.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(config));
    ` });
    const log = () => readFileSync(fixture.info.logPath, 'utf8');
    onTestFailed(() => console.error(log().slice(-16000)));
    try {
      const { secret } = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
      const headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret };
      const api = async (method: string, path: string, body?: unknown): Promise<any> => {
        const response = await fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const result = await response.json();expect(response.ok, JSON.stringify(result)).toBe(true);return result;
      };
      const { bot } = await api('POST', '/api/bots', { name: 'Room fixture' });
      await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false });
      const { group: room } = await api('POST', '/api/groups', { name: 'Fixture room', memberIds: [bot.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: bot.id } } });
      const read = <T>(fn: (db: DatabaseSync) => T) => { const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });try { return fn(db); } finally { db.close(); } };
      const session = () => read(db => String(db.prepare("SELECT native_session FROM memory_disclosures WHERE thread_id=? AND state='delivered' AND native_session IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(room.threadId)?.native_session ?? ''));
      const replies = async () => (await api('GET', `/api/threads/${room.threadId}/messages?limit=100`)).messages.filter((m: any) => m.role === 'bot' && m.kind === 'text' && m.text).length;
      const send = async (text: string) => {
        const remaining = 60000 - Date.now() % 60000;
        if (remaining <= 10000) await new Promise(resolve => setTimeout(resolve, remaining + 1));
        const before = await replies();
        await api('POST', `/api/groups/${room.id}/messages`, { text });
        await expect.poll(replies, { timeout: 45000 }).toBe(before + 1);
        await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15000 }).not.toBe(true);
      };
      await send('Establish the room session.');
      const before = session();expect(before).toBeTruthy();
      const start = log().length;
      const rpcFile = join(fixture.info.dataDir, 'room-rpc.jsonl');
      const rpc = () => existsSync(rpcFile) ? readFileSync(rpcFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      const rpcStart = rpc().length;
      await send('Recover room with the same valid session.');
      await send('Continue the room after recovery.');
      // MAIN RULING 1115-RECALL-HELD-REPLACE: held context is replaced once; admitted recovery stays warm.
      if(recovery==='held')expect(session()).not.toBe(before);else expect(session()).toBe(before);
      const recovered=session();
      const recoveryLog = log().slice(start);
      expect(recoveryLog).toContain('fixture room recovery ' + recovery);
      // MAIN RULING 1115-RECALL-HELD-REPLACE.
      if(recovery==='held'){expect(recoveryLog.match(/fixture room reset/g)).toHaveLength(1);expect(recoveryLog).toContain('held-session-holds-recall');}
      else{expect(recoveryLog).not.toContain('fixture room reset');expect(recoveryLog).not.toContain('memory continuation reset');}
      // MAIN RULING 1115-RECALL-HELD-REPLACE.
      if(engine==='acp') expect(rpc().slice(rpcStart).filter(row => row.method==='session/new')).toHaveLength(recovery==='held'?1:0);
      else {
        const timings = recoveryLog.split('\n').filter(line => line.includes(`claude first-token thread=${room.threadId} `));
        expect(timings).toHaveLength(2);
        // MAIN RULING 1115-RECALL-HELD-REPLACE.
        for(const line of timings.slice(recovery==='held'?1:0))expect(line).toMatch(/process=reused|resumed=true/);
        if(recovery==='held')expect(timings[0]).toContain('resumed=false');
      }
      // A real durable session denial is the negative control: it must reset
      // once, replace the native session, and log that decision.
      const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
      try {
        db.exec('PRAGMA busy_timeout=10000');
        db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,700003)').run(room.threadId, 'verification', recovered);
        db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
      } finally { db.close(); }
      const deniedAt = log().length;
      await send('Continue after the room session was denied.');
      // MAIN RULING 1115-RECALL-HELD-REPLACE: deny the current replacement, retaining the same denial assertion.
      expect(session()).not.toBe(recovered);
      expect(log().slice(deniedAt).match(/fixture room reset/g)).toHaveLength(1);
      expect(log().slice(deniedAt).split('\n').filter(line => line.includes(`memory continuation reset thread=${room.threadId} `))).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 180000);
}
