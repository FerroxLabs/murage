// Owners: lintrig-1020 owns the witness, recall-scope owns view preparation, and the Fuigo driver owns approval attestation.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { proofWorld } from './session-proof-world.ts';

const ACP = fileURLToPath(new URL('./testing/fake-acp-cli.ts', import.meta.url));
const BRIM = 536870484;
const REFUSAL = 'Fuigo did not confirm your approval settings';

it.each([
  { policyAck: '0', outcome: REFUSAL },
  { policyAck: '1', outcome: 'hello from fake acp' },
])('an owner turn on a brim-full store gets $outcome with ACP ack=$policyAck', async ({ policyAck, outcome }) => {
  const world = await proofWorld('claude', 'none', `
    const {join:fixtureJoin}=await import('node:path');
    const authPath=fixtureJoin(process.env.HOME,'.fuigo');
    const fixtureFs=await import('node:fs');
    fixtureFs.mkdirSync(authPath,{recursive:true});
    fixtureFs.writeFileSync(fixtureJoin(authPath,'auth.json'),'{}');
    const fixtureData=process.env.MURAGE_DATA_DIR;
    const fixtureConfigPath=fixtureJoin(fixtureData,'config.json');
    const fixtureConfig=JSON.parse(fixtureFs.readFileSync(fixtureConfigPath,'utf8'));
    fixtureConfig.instances.verification={driver:'fuigoAgent',config:{cli:${JSON.stringify(ACP)}},environment:{
      FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',
      FAKE_ACP_MCP_READY_METHOD:'_fuigo/mcp_initialized',FAKE_ACP_RPC_FULL_LOG:fixtureJoin(fixtureData,'warm-rpc.jsonl'),
    }};
    fixtureFs.writeFileSync(fixtureConfigPath,JSON.stringify(fixtureConfig));
    process.env.FAKE_ACP_POLICY_ACK=${JSON.stringify(policyAck)};
    process.env.FAKE_ACP_SESSION_NEW_GATE=fixtureJoin(process.env.MURAGE_DATA_DIR,'session-reply');
  `);
  try {
    // Exercise the approval exchange independently of recall admission.
    await world.api('POST', '/api/memory/action', { action: 'configure', mode: 'off' });
    const bot = await world.bot();
    await world.api('PATCH', `/api/bots/${bot.id}`, { modelSelection: { instanceId: 'verification', model: 'fake-acp-model' } });
    const bytes = () => world.read(db => Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes));
    const responseRows = async () => (await world.api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
    const sent = (method: string) => world.rpc().some(rpc => rpc.method === method);
    world.write(db => db.prepare('UPDATE memory_recall_storage SET bytes=? WHERE id=1').run(BRIM));
    expect(bytes()).toBe(BRIM);
    await world.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Owner turn under recall storage pressure.' });
    await expect.poll(() => sent('session/new'), { timeout: 45_000 }).toBe(true);
    expect(bytes()).toBe(BRIM);
    expect(sent('session/prompt')).toBe(false);
    expect(JSON.stringify(await responseRows())).not.toContain(REFUSAL);
    writeFileSync(join(world.fixture.info.dataDir, 'session-reply'), '');
    await expect.poll(async () => JSON.stringify(await responseRows()), { timeout: 45_000 }).toContain(outcome);
    expect(sent('session/prompt')).toBe(policyAck === '1');
  } finally {
    await world.fixture.close();
  }
}, 240_000);
