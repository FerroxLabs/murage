// 1.0.23 livebrowser through the real owner HTTP route on a booted server: a saved "browser didn't close" refusal with no daemon
// identity and nothing of the session left is cleared at boot, so the first GET (which binds the browser for the bot's turn)
// shows it usable; one whose session still names a live process stays refused until that process is gone, and then the owner's
// Restart clears it. The close-only relay refuses exactly as production does when the ownership record is missing.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
const instrumentation = `
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const dir = process.env.MURAGE_DATA_DIR;
const binary = join(dir, 'fake-agent-browser'); writeFileSync(binary, '#!/bin/sh\\nexit 0\\n', {mode:0o755});
process.env.MURAGE_AGENT_BROWSER_PATH = binary;
const config = JSON.parse(readFileSync(join(dir,'config.json'),'utf8')); config.features={browser:true}; writeFileSync(join(dir,'config.json'),JSON.stringify(config));
const bots=['noid','late'].map(mode=>({id:'bot-'+mode,name:'Kai '+mode,threadId:'thread-'+mode,browserProfile:'guest',tasks:[],selectionRevision:0}));
writeFileSync(join(dir,'bots.json'),JSON.stringify(bots));
for(const bot of bots)mkdirSync(join(dir,'sock-'+bot.id),{recursive:true});
const helper=spawn('/bin/sleep',['600'],{stdio:'ignore'}); helper.unref();
writeFileSync(join(dir,'sock-bot-late','saved-bot-late.pid'),String(helper.pid)); writeFileSync(join(dir,'late-helper.pid'),String(helper.pid));
writeFileSync(join(dir,'browser-control.json'),JSON.stringify(bots.map(bot=>['saved-'+bot.id,{generation:3,held:false,owner:null,closeFailed:true,...(bot.id==='bot-noid'?{closeRefused:false}:{}),closeTarget:{botId:bot.id,command:'/fixture/'+bot.id,socketDir:join(dir,'sock-'+bot.id),session:'saved-'+bot.id}}])));
registerHooks({load(url,context,nextLoad){
  if(url.endsWith('/browser-native-relay.ts'))return {format:'module',shortCircuit:true,source:\`
    export function createNativeBrowser(spec,options){return {
      protected:async()=>false,request:async()=>({tools:[]}),command:async()=>({}),connect:async()=>'stream',input(){},resetStream(){},
      close:async()=>{if(options?.closeOnly)throw new Error('Browser ownership is unconfirmed; try closing it again');}
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
  return { status: response.status, body: await response.json() as Record<string, any> };
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 60000);
afterAll(async () => {
  try { process.kill(Number(readFileSync(join(fixture.info.dataDir, 'late-helper.pid'), 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  await fixture?.close();
});
it('R1 boot clears a saved refusal (saved as not deliberate) whose session has nothing left running, and the first GET binds a usable browser', async () => {
  const status = await api('noid');
  expect(status).toMatchObject({ status: 200, body: { closeFailed: false, closing: false } });
});
it('R2 a session that still names a live process stays refused; once it is gone the owner Restart clears it', async () => {
  const held = await api('late');
  expect(held).toMatchObject({ status: 200, body: { closeFailed: true } });
  expect(await api('late', { action: 'restart', expectedKey: held.body.sessionKey, expectedRevision: 0 })).toMatchObject({ status: 503, body: { code: 'browser_close_failed' } });
  const pid = Number(readFileSync(join(fixture.info.dataDir, 'late-helper.pid'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  const restart = await api('late', { action: 'restart', expectedKey: held.body.sessionKey, expectedRevision: 0 });
  expect(restart).toMatchObject({ status: 200, body: { closeFailed: false } });
  expect((await api('late')).body.closeFailed).toBe(false);
});
