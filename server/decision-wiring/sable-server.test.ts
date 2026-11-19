// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { strictFakeAdapterInstrumentation } from './sable-runtime-fixture.ts';

// Replay S1's shapes through the production request ingress, authority,
// decisions, SQL persistence and CLI permission transport. Only the CLI and
// its strict acknowledgement adapter are fake; outside marks are fixture inputs.
const commands = ["cat <<'EOF' > /tmp/fixture.txt\nfixture body\nEOF", 'cat <<EOF > /tmp/fixture.txt\nfixture body\nEOF', 'printf x > "$DEST"', "printf '%s' 'fixture' >> /tmp/fixture.txt", 'cat <<EOF > "$DEST"\nfixture\nEOF', 'printf x > /tmp/fixture.txt', 'cat <<"EOF" > /tmp/fixture.txt\nfixture\nEOF', 'cat > /tmp/fixture.txt <<EOF\nfixture\nEOF'];
const tools = [['Bash', {command:'git status; printf fixture > /tmp/fixture.txt'}], ['Write', {file_path:'/tmp/fixture.txt', content:'fixture'}], ['mcp__murage__register_artifact', {path:'/tmp/fixture.txt'}], ['mcp__tvcontrol__quote_batch', {quotes:['fixture']}], ['mcp__browser__open', {url:'https://example.test'}], ['mcp__browser__screenshot', {}], ['mcp__browser__title', {}], ['mcp__thrivecart__lookup', {id:'fixture'}], ['mcp__connectors__list', {}]] as const;
const requests = [...tools, ...commands.map(command => ['Bash', {command}] as const)].map(([tool,input]) => ({tool,input}));
const root = new URL('../../', import.meta.url);
const moduleUrl = (path: string) => new URL(path, root).href;
let fixture: VerificationServer, headers: Record<string,string>;
const evidence: unknown[] = [];
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {method, headers: {...headers, 'content-type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const value = await response.json() as any;
  evidence.push({method, path, status:response.status, body:value});
  expect(response.ok, JSON.stringify({path, status:response.status, value})).toBe(true);
  return value;
}
function trace(): any[] {
  const path = join(fixture.info.dataDir, 's4-sable-trace.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
beforeAll(async () => {
  // Make a fixture-owned CLI from the established fake, keeping its MCP wire
  // implementation. Loop its ordinary permission request over the manifest;
  // these are requests only, no shell command or external tool is executed.
  let cli = readFileSync(new URL('../testing/fake-claude-cli.ts', import.meta.url), 'utf8')
    .replace(/from "(\.[^"]*)"/g, (_all, path) => `from ${JSON.stringify(new URL(path, moduleUrl('server/testing/fake-claude-cli.ts')).href)}`);
  const begin = cli.indexOf('const playPermissionTool = async ()'), end = cli.indexOf('\n};', begin) + 3;
  let body = cli.slice(begin, end);
  const varsEnd = body.indexOf('  const toolUseId');
  body = body.slice(0, body.indexOf('  const tool =')) + `  const {requests, outside} = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_S4_SHAPES_FILE!, 'utf8'));\n  for (const {tool, input} of requests) {\n` + body.slice(varsEnd);
  // Decorative tool frames would invoke service producers as well as the real permission request.
  body = body.split('\n').filter(line => !line.includes('type: "tool_use", id: toolUseId') && !line.includes('type: "tool_result", tool_use_id: toolUseId')).join('\n');
  body = body.replace('  out({ type: "result",', '  }\n  out({ type: "assistant", message: { content: [{ type: "text", text: `s4 batch complete: ${outside}: ${requests.length}` }] } });\n  out({ type: "result",');
  cli = cli.slice(0, begin) + body + cli.slice(end);
  const instrumentation = `
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const data = process.env.MURAGE_DATA_DIR;
const manifest = join(data, 's4-sable-requests.json');
const configPath = join(data, 'config.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
const cliPath = join(data, 's4-sable-cli.ts'); writeFileSync(cliPath, ${JSON.stringify(cli)}, {mode:0o755});
config.instances.verification.config.cli = cliPath;
config.instances.verification.environment = {FAKE_CLAUDE_S4_SHAPES_FILE:manifest}; writeFileSync(configPath, JSON.stringify(config));
const trace = event => appendFileSync(join(data, 's4-sable-trace.jsonl'), JSON.stringify(event)+'\\n');
registerHooks({load(url, context, next) { const result = next(url, context);
  if(url.endsWith('/server/harness/registry.ts')) return {...result, source:String(result.source)+${JSON.stringify(strictFakeAdapterInstrumentation)}};
  return result;
}});
const {installDecisionObserver} = await import(${JSON.stringify(moduleUrl('server/decision/index.ts'))});
const {EventBus} = await import(${JSON.stringify(moduleUrl('server/harness/bus.ts'))});
const {beginOutsideTurn, markTurnOutside, turnOutsideRead} = await import(${JSON.stringify(moduleUrl('server/email/external-marks.ts'))});
installDecisionObserver(trace);
const publish = EventBus.prototype.publish, fixtureMarkedThreads = new Set();
EventBus.prototype.publish = function(event, source) {
  if(event.type==='request.opened') {
    const {outside} = JSON.parse(readFileSync(manifest,'utf8'));
    if(!fixtureMarkedThreads.has(event.threadId)) {
      beginOutsideTurn(event.threadId,event.providerInstanceId,event.turnId,false); fixtureMarkedThreads.add(event.threadId);
    }
    markTurnOutside(event.threadId, outside);
    trace({type:'outside-input', requestId:event.requestId, outside:turnOutsideRead(event.threadId), tool:event.tool});
  }
  return publish.call(this,event,source);
};`;
  fixture = await launchVerificationServer(process.env, undefined, {instrumentationSource:instrumentation, readyTimeoutMs:120_000});
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as {secret:string};
  headers = {'x-murage-surface':'desktop', 'x-murage-surface-secret':proof.secret};
}, 150_000);
afterAll(async () => {
  if (!fixture) return;
  const path = process.env.S4_SABLE_EVIDENCE ?? join(tmpdir(), 's4-sable-evidence.json');
  evidence.push({fixture:fixture.info, trace:trace()});
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  writeFileSync(path.replace(/\.json$/, '.server.log'), readFileSync(fixture.info.logPath));
  await fixture.close();
}, 30_000);
it.each(['owner', 'owner-routine'])('BLOCK 3 Sable production acceptance: %s, 51 deliveries, zero permission cards', async actor => {
  for (const outside of ['web page', 'earlier turn', 'cloned folder']) {
    const instance = (await api('GET','/api/instances')).instances.find((i:any) => i.instanceId === 'verification');
    const {bot} = await api('POST','/api/bots',{name:'Sable '+actor, modelSelection:{instanceId:'verification', model:instance.models.options[0]?.id || instance.models.default || 'fixture-model'}});
    await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:true,composio:false});
    const preview = await api('POST',`/api/bots/${bot.id}/permissions/refresh`,{scope:'open',targetLevel:'no-limits'});
    const patched = await api('PATCH',`/api/bots/${bot.id}`,{settingsScope:'defaults',previewId:preview.previewId,ifRev:preview.botRev,autoApprove:true,fullAccess:true,noLimits:true,acknowledgeNoLimits:true});
    await api('POST',`/api/bots/${bot.id}/permissions/refresh`,{scope:'open',rosterId:preview.rosterId,targetLevel:'no-limits',afterRev:patched.bot.permissionRev});
    writeFileSync(join(fixture.info.dataDir,'s4-sable-requests.json'), JSON.stringify({outside,requests}));
    const before = trace().length;
    let threadId = bot.threadId;
    if (actor === 'owner') await api('POST',`/api/bots/${bot.id}/messages`,{threadId,text:'__fixture_permission_tool__'});
    else {
      const {routine} = await api('POST','/api/routines',{botId:bot.id,name:'Sable '+outside,prompt:'__fixture_permission_tool__',enabled:false,permissionMode:'unlimited',schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()+3_600_000}});
      const {run} = await api('POST',`/api/routines/${routine.id}/run`,{});
      await expect.poll(async () => { const list = await api('GET','/api/routines'); threadId = list.runs.find((r:any) => r.id === run.id)?.threadId; return Boolean(threadId); },{timeout:30_000,interval:100}).toBe(true);
    }
    let rows: any[] = [];
    await expect.poll(async () => {
      const value = await api('GET',`/api/threads/${encodeURIComponent(threadId)}/messages?limit=200`);
      rows = value.messages;
      return rows.some(row => row.text?.includes(`s4 batch complete: ${outside}: 17`));
    },{timeout:Number(process.env.S4_SABLE_TIMEOUT_MS ?? 60_000),interval:100}).toBe(true);
    const events = trace().slice(before), registered = events.filter(e => e.type === 'registered');
    expect(registered).toHaveLength(17);
    expect(registered.every(e => e.actor === actor && e.level === 'unlimited')).toBe(true);
    expect(new Set(events.filter(e => e.type === 'outside-input').map(e => e.requestId)).size).toBe(17);
    expect(events.filter(e => e.type === 'outside-input').every(e => e.outside === outside)).toBe(true);
    expect(new Set(events.filter(e => e.type === 'decided').map(e => e.requestKey)).size).toBe(17);
    expect(events.filter(e => e.type === 'decided').every(e => e.kind === 'run')).toBe(true);
    expect(events.filter(e => e.type === 'delivery')).toHaveLength(17);
    expect(events.filter(e => e.type === 'delivery').every(e => e.state === 'accepted')).toBe(true);
    expect(rows.filter(row => row.card?.requestId)).toHaveLength(0);
    expect(rows.map(row => row.text ?? '').join('\n').match(/permission: allowed/g)).toHaveLength(17);
    evidence.push({actor,outside,requests:17,accepted:17,cards:0});
    if (actor === 'owner') await expect.poll(async () => (await api('GET','/api/bots?messages=1')).bots.find((b:any)=>b.id===bot.id)?.activity,{timeout:20_000,interval:100}).not.toBe('working');
  }
}, 240_000);
