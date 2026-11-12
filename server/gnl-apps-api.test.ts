// SPDX-License-Identifier: AGPL-3.0-or-later
// Real authenticated dispatch, mounts and result collection against an isolated harness.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { waitForExit } from './testing/cleanup.ts';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { BASE, stderr, desktopApi, startInternalFixtureTurn, stopFixtureTurn } from './testing/index-harness.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { startFakeRemoteMcp, type FakeRemoteMcp } from './testing/fake-remote-mcp.ts';
process.env.MURAGE_TEST_FAKE_FLUX_BROKER='1';
let fake: FakeRemoteMcp;
const evidence: unknown[] = [];
beforeAll(async () => { fake = await startFakeRemoteMcp({auth:'none'}); });
afterAll(async () => {
  mkdirSync('evidence/gnl-apps',{recursive:true});
  writeFileSync('evidence/gnl-apps/apps.json',JSON.stringify({url:BASE,evidence},null,2));
  writeFileSync('evidence/gnl-apps/apps-server.log',stderr);
  await fake?.close();
  delete process.env.MURAGE_TEST_FAKE_FLUX_BROKER;
});

async function restrictedBot(name: string, unlimited = true) {
  const bot = (await desktopApi('POST', '/api/bots', { name })).body.bot;
  await desktopApi('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, autoReview: 'off' });
  const view = await desktopApi('GET', `/api/bots/${bot.id}/access`);
  expect((await desktopApi('PUT', `/api/bots/${bot.id}/access`, { action: 'configure', revision: view.body.policy.revision, mode: 'restricted', allowWrites: false, grants: [] })).status).toBe(200);
  if (unlimited) expect((await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  else expect((await desktopApi('PATCH',`/api/bots/${bot.id}/tasks/${bot.threadId}`,{autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
  return bot;
}
const rpc = async (token: string, body: unknown, path = '/api/internal/connectors/mcp') => {
  const res = await fetch(BASE + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result={ status: res.status, body: await res.json() as any };
  evidence.push({path,request:body,...result});
  return result;
};
it('GNL-A1 saved write/tool/account limits do not block real No limits dispatch, discovery or collection', async () => {
  const bot = await restrictedBot('GNL apps dispatch');
  const turn = await startInternalFixtureTurn(bot.id, undefined, '__fixture_hold_authority__');
  try {
    const env = turn.dump.mcpConfig.mcpServers.murage_connectors.env;
    const token = env.MURAGE_CONNECTORS_TOKEN;
    const sent = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'fixture-account', arguments: { to: 'fixture@example.invalid', body: 'GNL fixture' } }] } } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.result?.isError).not.toBe(true);
    expect(sent.body.result?.content).toBeTruthy();
    expect(env.MURAGE_CONNECTOR_INITIAL_TOOLS).toBeUndefined();
    const current=await desktopApi('GET',`/api/bots/${bot.id}/access`);
    expect((await desktopApi('PUT',`/api/bots/${bot.id}/access`,{action:'configure',revision:current.body.policy.revision,mode:'restricted',allowWrites:false,grants:[]})).status).toBe(200);
    const again = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'fixture-account', arguments: { to: 'fixture@example.invalid', body: 'GNL fixture' } }] } } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.result?.isError).not.toBe(true);
    expect(JSON.stringify(again.body)).not.toContain('not run again');
    expect((await desktopApi('GET', `/api/bots/${bot.id}/access`)).body.policy).toMatchObject({ mode: 'restricted', allowWrites: false, grants: [] });
  } finally { await stopFixtureTurn(bot.id, turn); }
});
it('GNL-A1 restricted No limits turns receive enabled owner MCP servers', async () => {
  expect((await desktopApi('POST', '/api/mcp/servers', { name: 'gnlnotes', command: 'node', args: ['fixture-only'], enabled: true })).status).toBe(201);
  expect((await desktopApi('PATCH', '/api/mcp/servers/gnlnotes', { enabled: true })).status).toBe(200);
  expect((await desktopApi('POST', '/api/mcp/servers', {name:'gnllink',url:fake.mcpUrl,auth:'none',confirmLocal:'this-computer'})).status).toBe(201);
  expect((await desktopApi('PATCH','/api/mcp/servers/gnllink',{enabled:true})).status).toBe(200);
  const bot = await restrictedBot('GNL own MCP');
  const turn = await startInternalFixtureTurn(bot.id, undefined, '__fixture_hold_authority__');
  try {
    expect(turn.dump.mcpConfig.mcpServers).toHaveProperty('gnlnotes');
    expect(turn.dump.mcpConfig.mcpServers).toHaveProperty('gnllink');
    const token=turn.dump.mcpConfig.mcpServers.gnllink.env.MURAGE_MCP_TOKEN;
    const reply=await rpc(token,{jsonrpc:'2.0',id:1,method:'tools/list'},'/api/internal/mcp-remote/gnllink');
    expect(reply.status,JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.result.tools.map((x:any)=>x.name)).toContain('echo');
    expect((await desktopApi('PATCH','/api/mcp/servers/gnllink',{enabled:false})).status).toBe(200);
    const disabled=await rpc(token,{jsonrpc:'2.0',id:2,method:'tools/list'},'/api/internal/mcp-remote/gnllink');
    expect(disabled.status).toBe(404);
    expect(disabled.body.error).toBe('gnllink is off; turn it on in App Settings → Connections → Your MCP servers.');
  }
  finally { await stopFixtureTurn(bot.id, turn); await desktopApi('DELETE', '/api/mcp/servers/gnlnotes'); await desktopApi('DELETE','/api/mcp/servers/gnllink'); }
});
it('GNL-A1 Ask retains saved connected-app restrictions', async () => {
  const bot = await restrictedBot('GNL Ask parity', false);
  const turn = await startInternalFixtureTurn(bot.id, undefined, '__fixture_hold_authority__');
  try {
    const sent = await rpc(turn.dump.mcpConfig.mcpServers.murage_connectors.env.MURAGE_CONNECTORS_TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'COMPOSIO_SEARCH_TOOLS', arguments: {} } });
    expect(sent.status).toBe(403);
  } finally { await stopFixtureTurn(bot.id, turn); }
});
async function proxyCall(env: Record<string,string>, name: string, args: unknown) {
  const child=spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./connector-proxy.ts',import.meta.url))],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',data=>{stderr+=data;});
  try {
    const reply=new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('connector proxy timed out: '+stderr)),20000);
      lines.on('line',line=>{try{const value=JSON.parse(line);if(value.id===71){clearTimeout(timer);resolve(value);}}catch{}});
    });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:71,method:'tools/call',params:{name,arguments:args}})+'\n');
    return await reply;
  } finally {lines.close();await waitForExit(child,{signal:'SIGTERM'});}
}
it('GNL-A4 a disconnected app request at No limits gives one off line and no connector card', async () => {
  const bot = await restrictedBot('GNL disconnected');
  const view=await desktopApi('GET',`/api/bots/${bot.id}/access`);
  expect((await desktopApi('PUT',`/api/bots/${bot.id}/access`,{action:'configure',revision:view.body.policy.revision,mode:'unrestricted',allowWrites:true,grants:[]})).status).toBe(200);
  const turn = await startInternalFixtureTurn(bot.id, undefined, '__fixture_hold_authority__');
  try {
    const env=turn.dump.mcpConfig.mcpServers.murage_connectors.env;
    const visible=await proxyCall(env,'COMPOSIO_MANAGE_CONNECTIONS',{toolkits:['gmail']});
    expect(visible.result).toEqual({content:[{type:'text',text:'gmail is disconnected; turn it on in App Settings → Connections → Connected apps.'}]});
    evidence.push({tool:'COMPOSIO_MANAGE_CONNECTIONS',reply:visible});
    const waiting=await proxyCall(env,'COMPOSIO_WAIT_FOR_CONNECTIONS',{});
    expect(JSON.stringify(waiting)).not.toMatch(/will continue|waiting|End this turn/);
    const result = await rpc(turn.dump.mcpConfig.mcpServers.murage_connectors.env.MURAGE_CONNECTORS_TOKEN, { botId: bot.id, threadId: bot.threadId, resumeKey: 'gnl-disconnected-fixture', items: [{ slug: 'gmail' }] }, '/api/internal/connectors/request');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ pending: false, messageIds: [], message: 'gmail is disconnected; turn it on in App Settings → Connections → Connected apps.' });
    const rows = (await desktopApi('GET', `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages;
    expect(rows.filter((m: any) => m.kind === 'connector')).toHaveLength(0);
  } finally { await stopFixtureTurn(bot.id, turn); }
});
