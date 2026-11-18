// Owners: recall-s1s2g owns this isolated launcher; warm-keep owns its original workflow.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, onTestFailed } from 'vitest';
import type { VerificationServer } from '../scripts/control-murage.ts';
import { launchMemoryVerificationServer as launchVerificationServer, waitForMemoryFixtureWindow } from './testing/memory-verification-fixture.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';
async function launchFixture(...args:Parameters<typeof launchVerificationServer>) {
 try{return await launchVerificationServer(...args);}
 catch(error){const file=String(error).match(/see (.+\.log)/)?.[1];if(file&&existsSync(file))console.error(readFileSync(file,'utf8'));throw error;}
}


export async function proofWorld(engine: 'claude' | 'acp', forceRecovery: 'none' | 'readiness' | 'checking' = 'none', extraSource = '') {
  const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
  const fixture: VerificationServer = await launchFixture(process.env, undefined, { dumpLog: true, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
${extraSource}
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){
      const result=next(url,context);let source=String(result.source);
      if (${JSON.stringify(forceRecovery !== 'none')} && url.endsWith('/server/index.ts')) {
        const needle='const {access,earlyVerdictHolds}=dispatchAccess(';
        source=source.replace(needle,\`if (/Owner turn (3|6|9):/.test(text) && globalThis.fixtureReadinessMessage!==userMessage.id) {
          globalThis.fixtureReadinessMessage=userMessage.id;
          ${forceRecovery === 'checking' ? "console.warn('fixture forced recall checking');throw new EngineInputRevoked({state:'checking',reason:'lookup-error'});" : "database().prepare('DELETE FROM memory_recall_contexts WHERE view_id=? AND generation=?').run(earlyBundle.access.view.viewId,earlyBundle.access.view.generation);console.warn('fixture forced recall readiness');"}
        }\`+needle);
      }
      return {...result,source};
    }});
    await import(${url('server/testing/fake-engine-env-preload.mjs')});
    // Deterministic idle host: normal capture must not wait on unrelated CI-machine load.
    await import(${url('server/testing/idle-load-preload.mjs')});
    process.env.MURAGE_TURN_TRACE='1';
    const fs=await import('node:fs'),path=await import('node:path');
    const {fileURLToPath}=await import('node:url');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
    if (${JSON.stringify(engine)}==='acp') config.instances.verification={driver:'grokAgent',config:{cli:fileURLToPath(${url('server/testing/fake-acp-cli.ts')})},environment:{
      FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',
      FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'warm-rpc.jsonl')}};
    fs.writeFileSync(file,JSON.stringify(config));
  ` });
  onTestFailed(() => console.error(readFileSync(fixture.info.logPath, 'utf8').slice(-12_000)));
  let headers: Record<string, string> = {};
  const login = async () => {
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  };
  await login();
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    if (method === 'POST' && (path.includes('/messages') || path.startsWith('/fixture/seed-long?'))) await waitForMemoryFixtureWindow();
    const response = await fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const read = <T>(fn: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true }); try { return fn(db); } finally { db.close(); } };
  const write = (fn: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db')); try { db.exec('PRAGMA busy_timeout=10000'); fn(db); } finally { db.close(); } };
  const log = () => readFileSync(fixture.info.logPath, 'utf8');
  const session = (thread: string) => read(db => String(db.prepare("SELECT native_session FROM memory_disclosures WHERE thread_id=? AND state='delivered' AND native_session IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(thread)?.native_session ?? ''));
  const bot = async () => {
    const { bot } = await api('POST', '/api/bots', { name: 'Warm fixture' });
    await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false });
    return bot as { id: string; threadId: string };
  };
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: drive warm-keep's original owner send/capture sequence; recall readiness can remain held.
  const acceptedTurn = async (bot: { id: string; threadId: string }, text: string, capture: 'expected' | 'excluded' = 'expected') => {
    // As in the real memory fixtures, begin outside the five-second admission closing guard.
    const remaining = 60_000 - Date.now() % 60_000;
    if (remaining <= 10_000) await new Promise(resolve => setTimeout(resolve, remaining + 1));
    const replies = async () => (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages.filter((m: any) => m.role === 'bot' && m.kind === 'text' && m.text).length;
    const before = await replies(), logStart = log().length;
    const captured = read(db => Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE thread_id=?').get(bot.threadId)!.n));
    await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
    await expect.poll(replies, { timeout: 45_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15_000 }).not.toBe(true);
    expect(log().slice(logStart)).not.toContain('starting turn without recalled memory');
    const sourcesAfter = read(db => Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE thread_id=?').get(bot.threadId)!.n));
    if (capture === 'excluded') expect(sourcesAfter).toBe(captured);
    else expect(sourcesAfter).toBeGreaterThan(captured);
  };
  const turn = async (bot: { id: string; threadId: string }, text: string) => {
    await acceptedTurn(bot, text);
    await expect.poll(() => read(db => Number(db.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(bot.threadId)!.n)), { timeout: 30_000 }).toBe(0).catch(error => { console.error("fixture pending jobs="+JSON.stringify(read(db=>db.prepare("SELECT stage,status,error,retry_at FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')").all())));throw error; });
  };
  const rpc = (): any[] => { const file = join(fixture.info.dataDir, 'warm-rpc.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
  return { fixture, login, api, read, write, log, session, bot, turn, acceptedTurn, rpc };
}
