import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
const instrumentation = `
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.MURAGE_DATA_DIR;
const binary = join(dir, 'fake-agent-browser'); writeFileSync(binary, '#!/bin/sh\\nexit 0\\n', {mode:0o755});
process.env.MURAGE_AGENT_BROWSER_PATH = binary;
const config = JSON.parse(readFileSync(join(dir,'config.json'),'utf8')); config.features={browser:true}; writeFileSync(join(dir,'config.json'),JSON.stringify(config));
const bots=['alive','gone','unknown'].map(mode=>({id:'bot-'+mode,name:'Kai '+mode,threadId:'thread-'+mode,browserProfile:'guest',tasks:[],selectionRevision:0}));
writeFileSync(join(dir,'bots.json'),JSON.stringify(bots));
writeFileSync(join(dir,'browser-control.json'),JSON.stringify(bots.map(bot=>['saved-'+bot.id,{generation:3,held:false,owner:null,closeFailed:true,daemonIdentity:{pid:123,start:'100',bootId:'boot'},closeTarget:{botId:bot.id,command:'/fixture/'+bot.id,socketDir:dir,session:'saved-'+bot.id}}])));
registerHooks({load(url,context,nextLoad){
  if(url.endsWith('/browser-daemon-identity.ts')){
    const source=readFileSync(new URL(url),'utf8'); const start=source.indexOf('export async function judgeDaemonIdentity(');
    return {format:'module-typescript',shortCircuit:true,source:source.slice(0,start)+"export async function judgeDaemonIdentity(identity, command) { return command.endsWith('gone') ? 'gone' : command.endsWith('alive') ? 'alive' : 'unknown'; }"};
  }
  if(url.endsWith('/browser-native-relay.ts'))return {format:'module',shortCircuit:true,source:\`
    import { appendFileSync } from 'node:fs';
    export function createNativeBrowser(spec){return {
      seedDaemonIdentity(identity){appendFileSync(\${JSON.stringify(join(dir,'browser-close-fixture.log'))},'seed '+identity.pid+'\\\\n');},
      protected:async()=>false,request:async()=>({tools:[]}),command:async()=>({}),connect:async()=>'stream',input(){},resetStream(){},
      close:async()=>{appendFileSync(\${JSON.stringify(join(dir,'browser-close-fixture.log'))},'close '+spec.env.AGENT_BROWSER_SESSION+'\\\\n');if(spec.command.endsWith('unknown'))throw new Error('timeout');}
    };}
  \`};
  if(url.endsWith('/browser-engine.ts')){
    const source=readFileSync(new URL(url),'utf8').replace('if (browserHostRequiresSandboxBypass({','if (false && browserHostRequiresSandboxBypass({'),start=source.indexOf('export async function verifyAgentBrowserBinary('),end=source.indexOf('export async function ensureChrome(',start);
    return {format:'module-typescript',shortCircuit:true,source:source.slice(0,start)+'export async function verifyAgentBrowserBinary() {}\\n'+source.slice(end)};
  }
  return nextLoad(url,context);
}});
`;
let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (mode: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}/api/bots/bot-${mode}/browser`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = { status: response.status, body: await response.json() as Record<string, any> };
  console.log('S3 owner HTTP', JSON.stringify({ mode, action: (body as { action?: string } | undefined)?.action ?? 'GET', ...result }));
  return result;
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  console.log('S3 isolated fixture', JSON.stringify(fixture.info));
}, 60000);
afterAll(async () => { await fixture?.close(); });
it('T20 real owner HTTP refuses legacy actions before binding', async () => {
  const response = await api('alive', { action: 'take' });
  expect(response).toMatchObject({ status: 409, body: { code: 'client_outdated' } });
});
it('T25 restored live Guest supports GET and close-only Restart through the real route', async () => {
  const status = await api('alive'); expect(status).toMatchObject({ status: 200, body: { closeFailed: true, sessionKey: 'saved-bot-alive', selectionRevision: 0, problem: "Kai alive's browser didn't close. Tap Restart to try again." } });
  const restart = await api('alive', { action: 'restart', expectedKey: status.body.sessionKey, expectedRevision: 0 });
  expect(restart).toMatchObject({ status: 200, body: { closeFailed: false } });
  expect(readFileSync(join(fixture.info.dataDir, 'browser-close-fixture.log'), 'utf8')).toContain('seed 123');
  expect(readFileSync(join(fixture.info.dataDir, 'browser-close-fixture.log'), 'utf8')).toContain('close saved-bot-alive');
  expect((await api('alive')).body.closeFailed).toBe(false);
});
it('T25 real GET rebinds after verified termination; unknown identity stays refused', async () => {
  expect(await api('gone')).toMatchObject({ status: 200, body: { closeFailed: false } });
  const unknown = await api('unknown'); expect(unknown).toMatchObject({ status: 200, body: { closeFailed: true } });
  expect(await api('unknown', { action: 'restart', expectedKey: unknown.body.sessionKey, expectedRevision: 0 })).toMatchObject({ status: 503, body: { code: 'browser_close_failed' } });
  expect((await api('unknown')).body.closeFailed).toBe(true);
});
